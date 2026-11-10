use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

// The SSE reader can cancel one native invocation while the connector and all
// other queued tasks keep their connection. IDs come from the owned stream.
#[derive(Clone, Default)]
pub struct TaskLeases(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);
impl TaskLeases {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let lease = Arc::new(AtomicBool::new(true));
        self.0.lock().unwrap().insert(id.into(), lease.clone());
        lease
    }
    pub fn cancel(&self, id: &str) {
        if let Some(lease) = self.0.lock().unwrap().get(id) {
            lease.store(false, Ordering::SeqCst);
        }
    }
    pub fn finish(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    pub fn disconnect(&self) {
        for lease in self.0.lock().unwrap().values() {
            lease.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_a_reply_preserves_other_tasks_and_stream() {
        let leases = TaskLeases::default();
        let first = leases.register("first");
        let second = leases.register("second");
        leases.cancel("first");
        leases.cancel("unknown");
        assert!(!first.load(Ordering::SeqCst));
        assert!(second.load(Ordering::SeqCst));
        leases.finish("first");
        let third = leases.register("third");
        leases.disconnect();
        assert!(!second.load(Ordering::SeqCst));
        assert!(!third.load(Ordering::SeqCst));
    }
}
