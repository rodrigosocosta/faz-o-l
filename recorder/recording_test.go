package main

import (
	"os/exec"
	"testing"
)

func TestExitedFFmpegIsNoLongerActive(t *testing.T) {
	command := exec.Command("sh", "-c", "exit 1")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	rec := &recording{cmd: command}
	rec.waitFFmpeg(command)
	if rec.cmd != nil {
		t.Fatal("processo encerrado continua contado como gravação ativa")
	}
}

func TestOldFFmpegExitDoesNotClearReplacement(t *testing.T) {
	old := exec.Command("sh", "-c", "exit 0")
	if err := old.Start(); err != nil {
		t.Fatal(err)
	}
	replacement := &exec.Cmd{}
	rec := &recording{cmd: replacement}
	rec.waitFFmpeg(old)
	if rec.cmd != replacement {
		t.Fatal("saída do processo anterior apagou o processo novo")
	}
}
