use std::collections::VecDeque;

pub struct LogQueue<T> {items:VecDeque<T>,capacity:usize}
impl<T> LogQueue<T> {
    pub fn new(capacity:usize)->Self {Self{items:VecDeque::new(),capacity}}
    pub fn push(&mut self,item:T) {
        if self.capacity==0{return}
        if self.items.len()>=self.capacity{self.items.pop_front();}
        self.items.push_back(item);
    }
    pub fn drain(&mut self,count:usize)->Vec<T> {self.items.drain(..count.min(self.items.len())).collect()}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_queue_keeps_recent_and_drains_in_batches() {
        let mut queue=LogQueue::new(3);
        for n in 0..5 {queue.push(n);}
        assert_eq!(queue.drain(2),vec![2,3]);
        assert_eq!(queue.drain(2),vec![4]);
        assert!(queue.drain(2).is_empty());
    }
}
