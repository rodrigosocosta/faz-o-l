// Faz o L — gravador de clipes.
//
// Entra na sala escondido, recebe cada live (tela + áudio da tela + vozes) e repassa os
// pacotes RTP, sem decodificar, para um ffmpeg local que salva pedaços de ~4 s
// em Matroska (-c copy). Mantém só os últimos minutos. Quando o site pede um
// clipe, junta os pedaços que cobrem os últimos N segundos num MP4/WebM.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

const (
	identityRecorder = "fazol-recorder"
	segmentSeconds   = 4
	keyframeEvery    = 3 * time.Second
	keepBuffer       = 240 * time.Second // 4 min (clipe máximo de 3 min + folga)
	restartDebounce  = 1500 * time.Millisecond
)

var (
	livekitURL = env("LIVEKIT_WS_URL", "ws://fazol-livekit:7880")
	apiKey     = os.Getenv("LIVEKIT_API_KEY")
	apiSecret  = os.Getenv("LIVEKIT_API_SECRET")
	bufferDir  = env("BUFFER_DIR", "/data/buffer")
	clipsDir   = env("CLIPS_DIR", "/data/clips")
	listenAddr = env("LISTEN", ":8090")

	nextPort atomic.Int32
	mu       sync.Mutex
	records  = map[string]*recording{} // "<sala>/<identidade>" -> gravação

	roomsMu sync.Mutex
	rooms   = map[string]*lksdk.Room{} // salas em que o gravador está
)

func recordKey(room, identity string) string { return room + "/" + identity }

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ---------------------------------------------------------------------------
// Gravação de uma live
// ---------------------------------------------------------------------------

type forward struct {
	track *webrtc.TrackRemote
	rp    *lksdk.RemoteParticipant
	port  int // RTP; RTCP vai em port+1
	rtp   *net.UDPConn
	rtcp  *net.UDPConn
	stop  chan struct{}
}

type segment struct {
	path  string
	start time.Time
}

type recording struct {
	identity string
	dir      string

	mu        sync.Mutex
	video     *forward
	audio     *forward
	voices    *forward // vozes do Discord (só entram no clipe)
	videoMime string
	cmd       *exec.Cmd
	run       int
	restart   *time.Timer
	segments  []segment
	seen      map[string]bool
}

var unsafeChars = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

func getRecording(room, identity string) *recording {
	key := recordKey(room, identity)
	mu.Lock()
	defer mu.Unlock()
	rec := records[key]
	if rec == nil {
		dir := filepath.Join(bufferDir, unsafeChars.ReplaceAllString(room+"__"+identity, "_"))
		_ = os.MkdirAll(dir, 0o755)
		rec = &recording{identity: key, dir: dir, seen: map[string]bool{}}
		records[key] = rec
	}
	return rec
}

func allocPort() int {
	p := 30000 + int(nextPort.Add(2))%20000
	return p - p%2 // RTP par, RTCP ímpar
}

func dialUDP(port int) *net.UDPConn {
	conn, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		slog.Warn("falha no envio UDP", "error", err)
		return nil
	}
	return conn
}

func (rec *recording) addTrack(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
	port := allocPort()
	fw := &forward{track: track, rp: rp, port: port, rtp: dialUDP(port), rtcp: dialUDP(port + 1), stop: make(chan struct{})}

	rec.mu.Lock()
	if track.Kind() == webrtc.RTPCodecTypeVideo {
		if rec.video != nil {
			close(rec.video.stop)
		}
		rec.video = fw
		rec.videoMime = strings.ToLower(track.Codec().MimeType)
	} else if isVoices(pub) {
		if rec.voices != nil {
			close(rec.voices.stop)
		}
		rec.voices = fw
	} else {
		if rec.audio != nil {
			close(rec.audio.stop)
		}
		rec.audio = fw
	}
	rec.scheduleRestart()
	rec.mu.Unlock()

	// Relatórios RTCP (Sender Report) -> ffmpeg, pra sincronizar áudio e vídeo
	pub.OnRTCP(func(pkt rtcp.Packet) {
		if sr, ok := pkt.(*rtcp.SenderReport); ok && fw.rtcp != nil {
			if raw, err := sr.Marshal(); err == nil {
				_, _ = fw.rtcp.Write(raw)
			}
		}
	})

	// Quadro-chave a cada poucos segundos: cada pedaço começa num quadro inteiro
	if track.Kind() == webrtc.RTPCodecTypeVideo {
		go func() {
			ticker := time.NewTicker(keyframeEvery)
			defer ticker.Stop()
			for {
				select {
				case <-fw.stop:
					return
				case <-ticker.C:
					rp.WritePLI(track.SSRC())
				}
			}
		}()
	}

	// Pacotes RTP crus -> ffmpeg
	go func() {
		buf := make([]byte, 1600)
		for {
			n, _, err := track.Read(buf)
			if err != nil {
				return
			}
			select {
			case <-fw.stop:
				return
			default:
			}
			if fw.rtp != nil {
				_, _ = fw.rtp.Write(buf[:n])
			}
		}
	}()
}

func (rec *recording) removeTrack(track *webrtc.TrackRemote) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.video != nil && rec.video.track == track {
		close(rec.video.stop)
		rec.video = nil
	}
	if rec.audio != nil && rec.audio.track == track {
		close(rec.audio.stop)
		rec.audio = nil
	}
	if rec.voices != nil && rec.voices.track == track {
		close(rec.voices.stop)
		rec.voices = nil
	}
	if rec.video == nil {
		rec.stopFFmpeg() // sem vídeo, sem gravação (os pedaços continuam valendo pra clipar)
	} else {
		rec.scheduleRestart()
	}
}

// (Re)inicia o ffmpeg com as trilhas atuais, esperando um pouco pra juntar vídeo e áudio.
func (rec *recording) scheduleRestart() {
	if rec.restart != nil {
		rec.restart.Stop()
	}
	rec.restart = time.AfterFunc(restartDebounce, func() {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		rec.stopFFmpeg()
		if rec.video != nil {
			rec.startFFmpeg()
		}
	})
}

func encodingName(mime string) string {
	parts := strings.SplitN(mime, "/", 2)
	if len(parts) != 2 {
		return mime
	}
	return strings.ToUpper(parts[1])
}

func mediaLine(kind string, fw *forward) string {
	c := fw.track.Codec()
	pt := uint8(fw.track.PayloadType())
	rtpmap := fmt.Sprintf("%s/%d", encodingName(c.MimeType), c.ClockRate)
	if kind == "audio" {
		rtpmap = fmt.Sprintf("opus/%d/%d", c.ClockRate, max(int(c.Channels), 2))
	}
	line := fmt.Sprintf("m=%s %d RTP/AVP %d\r\na=rtpmap:%d %s\r\n", kind, fw.port, pt, pt, rtpmap)
	if c.SDPFmtpLine != "" {
		line += fmt.Sprintf("a=fmtp:%d %s\r\n", pt, c.SDPFmtpLine)
	}
	return line
}

func (rec *recording) startFFmpeg() {
	rec.run++
	sdp := "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=fazol\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n" + mediaLine("video", rec.video)
	if rec.audio != nil {
		sdp += mediaLine("audio", rec.audio)
		if rec.voices != nil {
			sdp += mediaLine("audio", rec.voices)
		}
	}
	sdpPath := filepath.Join(rec.dir, fmt.Sprintf("run%04d.sdp", rec.run))
	if err := os.WriteFile(sdpPath, []byte(sdp), 0o644); err != nil {
		slog.Warn("falha ao preparar SDP", "error", err)
		return
	}

	pattern := filepath.Join(rec.dir, fmt.Sprintf("r%04d-%%06d.mkv", rec.run))
	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-protocol_whitelist", "file,udp,rtp",
		"-reorder_queue_size", "4000",
		"-i", sdpPath,
		"-map", "0", "-c", "copy",
		"-f", "segment",
		"-segment_time", fmt.Sprint(segmentSeconds),
		"-segment_format", "matroska",
		"-reset_timestamps", "1",
		pattern,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		slog.Warn("falha ao iniciar ffmpeg", "error", err)
		return
	}
	rec.cmd = cmd
	log.Printf("[%s] gravando (%s%s)", rec.identity, rec.videoMime, map[bool]string{true: " + áudio", false: ""}[rec.audio != nil]+map[bool]string{true: " + vozes", false: ""}[rec.audio != nil && rec.voices != nil])

	// Pede um quadro-chave assim que o ffmpeg estiver ouvindo
	video := rec.video
	go func() {
		time.Sleep(400 * time.Millisecond)
		video.rp.WritePLI(video.track.SSRC())
	}()
	go rec.waitFFmpeg(cmd)
}

func (rec *recording) waitFFmpeg(cmd *exec.Cmd) {
	err := cmd.Wait()
	rec.mu.Lock()
	unexpected := rec.cmd == cmd
	if unexpected {
		rec.cmd = nil
	}
	rec.mu.Unlock()
	if unexpected {
		slog.Error("ffmpeg encerrou durante gravação", "error", err)
	}
}

func (rec *recording) stopFFmpeg() {
	if rec.cmd == nil || rec.cmd.Process == nil {
		return
	}
	cmd := rec.cmd
	rec.cmd = nil
	_ = cmd.Process.Signal(os.Interrupt) // finaliza o pedaço atual direitinho
	go func() {
		time.Sleep(3 * time.Second)
		_ = cmd.Process.Kill()
	}()
}

// Registra pedaços novos (com o horário em que apareceram) e apaga os velhos.
func (rec *recording) scan() {
	files, _ := filepath.Glob(filepath.Join(rec.dir, "*.mkv"))
	rec.mu.Lock()
	defer rec.mu.Unlock()
	now := time.Now()
	for _, f := range files {
		if !rec.seen[f] {
			rec.seen[f] = true
			rec.segments = append(rec.segments, segment{path: f, start: now})
		}
	}
	kept := rec.segments[:0]
	for _, s := range rec.segments {
		if now.Sub(s.start) > keepBuffer {
			_ = os.Remove(s.path)
			delete(rec.seen, s.path)
			continue
		}
		kept = append(kept, s)
	}
	rec.segments = kept
	sdps, _ := filepath.Glob(filepath.Join(rec.dir, "run*.sdp"))
	for _, f := range sdps {
		if info, err := os.Stat(f); err == nil && now.Sub(info.ModTime()) > keepBuffer && rec.cmd == nil {
			_ = os.Remove(f)
		}
	}
}

func janitor() {
	for range time.Tick(500 * time.Millisecond) {
		mu.Lock()
		list := make([]*recording, 0, len(records))
		for _, r := range records {
			list = append(list, r)
		}
		mu.Unlock()
		for _, r := range list {
			r.scan()
		}
	}
}

// ---------------------------------------------------------------------------
// Clipes
// ---------------------------------------------------------------------------

type clipRequest struct {
	Room     string `json:"room"`
	Identity string `json:"identity"`
	Seconds  int    `json:"seconds"`
	ID       string `json:"id"`
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{6,32}$`)

// errTooEarly: a live acabou de começar e ainda não tem nada gravado.
var errTooEarly = fmt.Errorf("a live acabou de começar, ainda não tem nada gravado")

func makeClip(ctx context.Context, req clipRequest) (result map[string]any, clipErr error) {
	defer func() {
		if clipErr != nil {
			slog.ErrorContext(ctx, "clipe falhou", "error", clipErr)
		}
	}()
	ensureJoined(req.Room)

	// Live que acabou de começar: espera o gravador entrar e o primeiro pedaço sair
	var rec *recording
	var segs []segment
	var mime string
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		rec = records[recordKey(req.Room, req.Identity)]
		mu.Unlock()
		if rec != nil {
			rec.scan()
			rec.mu.Lock()
			segs = append([]segment(nil), rec.segments...)
			mime = rec.videoMime
			rec.mu.Unlock()
			if len(segs) > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			return nil, errTooEarly
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].start.Before(segs[j].start) })

	// Começa no último pedaço que inicia antes de "agora - N" (sempre num quadro-chave)
	target := time.Now().Add(-time.Duration(req.Seconds) * time.Second)
	first := 0
	for i, s := range segs {
		if !s.start.After(target) {
			first = i
		}
	}
	chosen := segs[first:]

	// Vozes do Discord: se os pedaços mais novos têm as duas trilhas de áudio, tira os
	// mais velhos com uma só (de antes de a live recomeçar). O concat segue as trilhas do
	// primeiro pedaço: sem isso o clipe inteiro sairia sem as vozes.
	withVoices := false
	for i := len(chosen) - 1; i >= 0 && i >= len(chosen)-3; i-- {
		if audioStreams(ctx, chosen[i].path) >= 2 {
			withVoices = true
			break
		}
	}
	if withVoices {
		var kept []segment
		for _, s := range chosen {
			if audioStreams(ctx, s.path) != 1 { // 0 = pedaço ainda sendo escrito: fica
				kept = append(kept, s)
			}
		}
		if len(kept) > 0 {
			chosen = kept
		}
	}

	list := filepath.Join(os.TempDir(), req.ID+".txt")
	var b strings.Builder
	for _, s := range chosen {
		if info, err := os.Stat(s.path); err == nil && info.Size() > 0 {
			fmt.Fprintf(&b, "file '%s'\n", strings.ReplaceAll(s.path, "'", `'\''`))
		}
	}
	if err := os.WriteFile(list, []byte(b.String()), 0o644); err != nil {
		return nil, err
	}
	defer os.Remove(list)

	ext, contentType := "webm", "video/webm"
	if strings.Contains(mime, "h264") || strings.Contains(mime, "av1") {
		ext, contentType = "mp4", "video/mp4"
	}
	file := req.ID + "." + ext
	out := filepath.Join(clipsDir, file)
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list}
	// Duas trilhas de áudio (som da live + vozes do Discord): junta numa só pro clipe
	if withVoices {
		codec := "libopus"
		if ext == "mp4" {
			codec = "aac"
		}
		args = append(args,
			"-filter_complex", "[0:a:0][0:a:1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97[a]",
			"-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", codec, "-b:a", "160k")
	} else {
		args = append(args, "-map", "0", "-c", "copy")
	}
	if ext == "mp4" {
		args = append(args, "-movflags", "+faststart")
	}
	args = append(args, out)
	if output, err := clipCommandOutput(ctx, "ffmpeg", args...); err != nil {
		return nil, fmt.Errorf("ffmpeg: %v: %s", err, strings.TrimSpace(string(output)))
	}
	info, err := os.Stat(out)
	if err != nil || info.Size() == 0 {
		return nil, fmt.Errorf("clipe vazio")
	}
	duration := time.Since(chosen[0].start).Seconds()
	slog.InfoContext(ctx, "clipe gerado", "segments", len(chosen), "duration", duration, "size", info.Size())
	return map[string]any{"file": file, "mime": contentType, "size": info.Size(), "duration": duration}, nil
}

// Quantas trilhas de áudio o pedaço tem (2 = som da live + vozes do Discord).
func audioStreams(ctx context.Context, path string) int {
	out, err := clipCommandOutput(ctx, "ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path)
	if err != nil {
		return 0
	}
	return len(strings.Fields(string(out)))
}

func newHTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("/clip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var req clipRequest
		if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&req) != nil || !safeID.MatchString(req.ID) || req.Seconds <= 0 || req.Seconds > 180 {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "pedido inválido"})
			return
		}
		res, err := makeClip(r.Context(), req)
		if err != nil {
			status := http.StatusInternalServerError
			if err == errTooEarly {
				status = http.StatusConflict
			}
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(res)
	})
	// O site avisa assim que uma live começa: o gravador entra na hora (sem esperar a varredura)
	mux.HandleFunc("/join", func(w http.ResponseWriter, r *http.Request) {
		ensureJoined(r.URL.Query().Get("room"))
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

// ---------------------------------------------------------------------------
// Sala
// ---------------------------------------------------------------------------

func isScreen(pub *lksdk.RemoteTrackPublication) bool {
	s := pub.Source()
	return s == livekit.TrackSource_SCREEN_SHARE || s == livekit.TrackSource_SCREEN_SHARE_AUDIO || isVoices(pub)
}

// Vozes do Discord de quem transmite pelo app (o site não toca; entram só nos clipes).
func isVoices(pub *lksdk.RemoteTrackPublication) bool {
	return pub.Name() == "voices" && pub.Kind() == lksdk.TrackKindAudio
}

func token(room string) (string, error) {
	grant := &auth.VideoGrant{RoomJoin: true, Room: room, Hidden: true}
	grant.SetCanPublish(false)
	grant.SetCanSubscribe(true)
	return auth.NewAccessToken(apiKey, apiSecret).
		SetVideoGrant(grant).
		SetIdentity(identityRecorder).
		SetName("Gravador de clipes").
		SetValidFor(24 * time.Hour).
		ToJWT()
}

// Entra numa sala (um canal) e passa a gravar as lives dela.
func joinRoom(name string) {
	callback := &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackPublished: func(pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
				if isScreen(pub) {
					_ = pub.SetSubscribed(true)
				}
			},
			OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
				if !isScreen(pub) {
					return
				}
				if track.Kind() == webrtc.RTPCodecTypeVideo {
					_ = pub.SetVideoQuality(livekit.VideoQuality_HIGH)
				}
				getRecording(name, rp.Identity()).addTrack(track, pub, rp)
			},
			OnTrackUnsubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
				getRecording(name, rp.Identity()).removeTrack(track)
			},
		},
		OnDisconnected: func() {
			roomsMu.Lock()
			delete(rooms, name)
			roomsMu.Unlock()
			log.Printf("[%s] saiu da sala", name)
		},
	}

	tok, err := token(name)
	if err != nil {
		slog.Warn("falha ao criar token da sala", "error", err)
		return
	}
	room, err := lksdk.ConnectToRoomWithToken(livekitURL, tok, callback, lksdk.WithAutoSubscribe(false))
	if err != nil {
		slog.Warn("falha ao entrar na sala", "error", err)
		return
	}
	roomsMu.Lock()
	rooms[name] = room
	roomsMu.Unlock()
	log.Printf("[%s] na sala, gravando as lives", name)

	// Lives que já estavam no ar quando o gravador entrou
	for _, rp := range room.GetRemoteParticipants() {
		for _, p := range rp.TrackPublications() {
			if pub, ok := p.(*lksdk.RemoteTrackPublication); ok && isScreen(pub) {
				_ = pub.SetSubscribed(true)
			}
		}
	}
}

var joining = map[string]bool{} // salas com entrada em andamento (protegido por roomsMu)

// Tira a sala do mapa, se ainda for a mesma conexão.
func forgetRoom(name string, room *lksdk.Room) {
	roomsMu.Lock()
	if rooms[name] == room {
		delete(rooms, name)
	}
	roomsMu.Unlock()
}

// Entra na sala em segundo plano, se ainda não estiver nela.
func ensureJoined(name string) {
	if name == "" {
		return
	}
	roomsMu.Lock()
	defer roomsMu.Unlock()
	if rooms[name] != nil || joining[name] {
		return
	}
	joining[name] = true
	go func() {
		joinRoom(name)
		roomsMu.Lock()
		delete(joining, name)
		roomsMu.Unlock()
	}()
}

// Fica de olho nas salas do LiveKit: entra nas que têm alguém transmitindo e sai
// das que ficaram sem live (os pedaços gravados continuam valendo pra clipar).
func watchRooms() {
	httpURL := strings.Replace(strings.Replace(livekitURL, "wss://", "https://", 1), "ws://", "http://", 1)
	client := lksdk.NewRoomServiceClient(httpURL, apiKey, apiSecret)
	idleSince := map[string]time.Time{}

	for range time.Tick(2 * time.Second) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		res, err := client.ListRooms(ctx, &livekit.ListRoomsRequest{})
		cancel()
		if err != nil {
			slog.Warn("falha ao listar salas", "error", err)
			continue
		}
		live := map[string]bool{}
		for _, r := range res.Rooms {
			if r.NumPublishers > 0 {
				live[r.Name] = true
			}
		}

		roomsMu.Lock()
		current := make(map[string]*lksdk.Room, len(rooms))
		for name, room := range rooms {
			current[name] = room
		}
		roomsMu.Unlock()
		// Conexão que caiu sem avisar (o OnDisconnected nem sempre é chamado): esquece
		// a sala pra entrar de novo. Sem isso o gravador ficava fora da sala pra sempre.
		for name, room := range current {
			if room.ConnectionState() == lksdk.ConnectionStateDisconnected {
				forgetRoom(name, room)
				delete(current, name)
				log.Printf("[%s] conexão caiu, entrando de novo", name)
			}
		}
		for name := range live {
			delete(idleSince, name)
			ensureJoined(name)
		}
		for name, room := range current {
			if live[name] {
				continue
			}
			if idleSince[name].IsZero() {
				idleSince[name] = time.Now()
			} else if time.Since(idleSince[name]) > 30*time.Second {
				delete(idleSince, name)
				room.Disconnect()
				// Desconectar daqui não chama o OnDisconnected: tira do mapa na mão
				forgetRoom(name, room)
				log.Printf("[%s] saiu da sala (sem live)", name)
			}
		}
	}
}

func main() {
	initLogging()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if apiKey == "" || apiSecret == "" {
		log.Fatal("defina LIVEKIT_API_KEY e LIVEKIT_API_SECRET")
	}
	_ = os.MkdirAll(bufferDir, 0o755)
	_ = os.MkdirAll(clipsDir, 0o755)
	// Pedaços de execuções anteriores não servem mais
	if entries, err := os.ReadDir(bufferDir); err == nil {
		for _, e := range entries {
			_ = os.RemoveAll(filepath.Join(bufferDir, e.Name()))
		}
	}
	go janitor()
	server := &http.Server{Addr: listenAddr, Handler: newHTTPHandler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Printf("API de clipes em %s", listenAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("API de clipes falhou")
			stop()
		}
	}()
	go watchRooms()
	<-ctx.Done()
	timeout, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(timeout)
}
