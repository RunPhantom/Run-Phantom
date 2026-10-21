//! A single pending fixture render, independent of the UI thread and private stdin authority.
use std::sync::{Condvar, Mutex};
use std::time::Instant;
#[cfg(test)] use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderTicket {
    pub id: String,
    pub generation: u64,
    pub value: i64,
    pub sequence: u64,
}
impl RenderTicket {
    pub fn matches_state(&self, generation: u64, value: i64, sequence: u64) -> bool {
        self.generation == generation && self.value == value && self.sequence == sequence
    }
}
struct Pending { ticket: RenderTicket, acknowledged: bool }
#[derive(Default)]
struct State { ready: bool, pending: Option<Pending> }
#[derive(Default)]
pub struct RenderGate {
    state: Mutex<State>, changed: Condvar,
    #[cfg(test)] waiting: AtomicBool,
}
impl RenderGate {
    /// Called only after the fixed local webview has installed its event listener.
    pub fn ready(&self) -> Result<Option<RenderTicket>, &'static str> {
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        if state.ready { return Ok(None); }
        state.ready = true;
        Ok(state.pending.as_ref().map(|p| p.ticket.clone()))
    }
    /// False means readiness must emit this retained ticket, rather than losing an early event.
    pub fn begin(&self, ticket: RenderTicket) -> Result<bool, &'static str> {
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        if state.pending.is_some() { return Err("unavailable"); }
        state.pending = Some(Pending { ticket, acknowledged: false });
        Ok(state.ready)
    }
    pub fn acknowledge(&self, ticket: &RenderTicket) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        if !state.ready { return Err("denied"); }
        let pending = state.pending.as_mut().ok_or("denied")?;
        if pending.ticket != *ticket || pending.acknowledged { return Err("denied"); }
        pending.acknowledged = true;
        self.changed.notify_all();
        Ok(())
    }
    /// Only the stdin worker waits; the Tauri/UI thread remains able to receive the ack command.
    pub fn wait(&self, ticket: &RenderTicket, deadline: Instant) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        loop {
            let pending = state.pending.as_ref().ok_or("cancelled")?;
            if pending.ticket != *ticket { return Err("cancelled"); }
            let remaining = match deadline.checked_duration_since(Instant::now()) {
                Some(remaining) if !remaining.is_zero() => remaining,
                _ => { state.pending = None; return Err("unavailable"); }
            };
            if pending.acknowledged { state.pending = None; return Ok(()); }
            #[cfg(test)] self.waiting.store(true, Ordering::SeqCst);
            let waited = self.changed.wait_timeout(state, remaining);
            #[cfg(test)] self.waiting.store(false, Ordering::SeqCst);
            state = waited.map_err(|_| "unavailable")?.0;
        }
    }
    pub fn abandon(&self, ticket: &RenderTicket) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        if state.pending.as_ref().map(|p| &p.ticket) == Some(ticket) {
            state.pending = None;
            self.changed.notify_all();
        }
        Ok(())
    }
    pub fn cancel(&self) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        state.pending = None;
        self.changed.notify_all();
        Ok(())
    }
    pub fn abandon_request(&self, id: &str, generation: u64) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| "unavailable")?;
        if state.pending.as_ref().map(|p| (p.ticket.id.as_str(), p.ticket.generation)) == Some((id, generation)) {
            state.pending = None;
            self.changed.notify_all();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    fn ticket() -> RenderTicket { RenderTicket { id: "host-request-a".into(), generation: 2, value: 7, sequence: 9 } }
    fn deadline() -> Instant { Instant::now() + Duration::from_secs(1) }
    fn wait_until_blocked(gate: &RenderGate) {
        let until = deadline();
        while !gate.waiting.load(Ordering::SeqCst) {
            assert!(Instant::now() < until, "owned render waiter did not reach condition wait");
            std::thread::yield_now();
        }
        // The flag is set while holding the state mutex immediately before Condvar releases it.
        // Acknowledgement/cancel therefore cannot take the mutex until the worker is waiting.
    }
    #[test] fn begin_before_listener_retains_exact_pending_ticket() {
        let gate = RenderGate::default(); let t = ticket();
        assert_eq!(gate.begin(t.clone()), Ok(false));
        assert_eq!(gate.acknowledge(&t), Err("denied"));
        assert_eq!(gate.ready(), Ok(Some(t.clone())));
        assert_eq!(gate.acknowledge(&t), Ok(()));
        assert_eq!(gate.wait(&t, deadline()), Ok(()));
    }
    #[test] fn listener_before_begin_emits_immediately_and_ready_is_idempotent() {
        let gate = RenderGate::default(); let t = ticket();
        assert_eq!(gate.ready(), Ok(None)); assert_eq!(gate.begin(t.clone()), Ok(true));
        assert_eq!(gate.ready(), Ok(None)); assert_eq!(gate.acknowledge(&t), Ok(()));
        assert_eq!(gate.wait(&t, deadline()), Ok(()));
    }
    #[test] fn missing_ack_reaches_real_deadline_and_late_ack_is_rejected() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        assert_eq!(gate.wait(&t, Instant::now() + Duration::from_millis(10)), Err("unavailable"));
        assert_eq!(gate.acknowledge(&t), Err("denied"));
    }
    #[test] fn wrong_generation_never_settles_pending_render() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        let mut wrong = t.clone(); wrong.generation -= 1;
        assert_eq!(gate.acknowledge(&wrong), Err("denied")); assert_eq!(gate.acknowledge(&t), Ok(()));
        assert_eq!(gate.wait(&t, deadline()), Ok(()));
    }
    #[test] fn wrong_sequence_never_settles_pending_render() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        let mut wrong = t.clone(); wrong.sequence -= 1;
        assert_eq!(gate.acknowledge(&wrong), Err("denied")); assert_eq!(gate.acknowledge(&t), Ok(()));
        assert_eq!(gate.wait(&t, deadline()), Ok(()));
    }
    #[test] fn wrong_value_never_settles_pending_render() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        let mut wrong = t.clone(); wrong.value -= 1;
        assert_eq!(gate.acknowledge(&wrong), Err("denied")); assert_eq!(gate.acknowledge(&t), Ok(()));
        assert_eq!(gate.wait(&t, deadline()), Ok(()));
    }
    #[test] fn wrong_request_id_never_settles_pending_render() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        let mut wrong = t.clone(); wrong.id = "stale-request".into();
        assert_eq!(gate.acknowledge(&wrong), Err("denied")); assert_eq!(gate.acknowledge(&t), Ok(()));
        assert_eq!(gate.wait(&t, deadline()), Ok(()));
    }
    #[test] fn duplicate_ack_cannot_reuse_a_completed_render() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        assert_eq!(gate.acknowledge(&t), Ok(())); assert_eq!(gate.acknowledge(&t), Err("denied"));
        assert_eq!(gate.wait(&t, deadline()), Ok(())); assert_eq!(gate.acknowledge(&t), Err("denied"));
    }
    #[test] fn old_ack_cannot_complete_a_new_ticket_or_abandon_it() {
        let gate = RenderGate::default(); let old = ticket(); gate.ready().unwrap(); gate.begin(old.clone()).unwrap();
        gate.abandon(&old).unwrap(); let mut next = old.clone(); next.id = "host-request-b".into();
        gate.begin(next.clone()).unwrap(); assert_eq!(gate.acknowledge(&old), Err("denied"));
        gate.abandon(&old).unwrap(); assert_eq!(gate.acknowledge(&next), Ok(())); assert_eq!(gate.wait(&next, deadline()), Ok(()));
    }
    #[test] fn cancellation_retires_pending_and_wakes_real_waiter() {
        let gate = Arc::new(RenderGate::default()); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        let (send, receive) = mpsc::channel(); let waiting = gate.clone(); let target = t.clone();
        let worker = std::thread::spawn(move || { send.send(()).unwrap(); waiting.wait(&target, deadline()) });
        receive.recv().unwrap(); wait_until_blocked(&gate); gate.cancel().unwrap();
        assert_eq!(worker.join().unwrap(), Err("cancelled")); assert_eq!(gate.acknowledge(&t), Err("denied"));
    }
    #[test] fn matching_ack_wakes_real_worker_without_main_thread_wait() {
        let gate = Arc::new(RenderGate::default()); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        let (send, receive) = mpsc::channel(); let waiting = gate.clone(); let target = t.clone();
        let worker = std::thread::spawn(move || { send.send(()).unwrap(); waiting.wait(&target, deadline()) });
        receive.recv().unwrap(); wait_until_blocked(&gate); assert_eq!(gate.acknowledge(&t), Ok(())); assert_eq!(worker.join().unwrap(), Ok(()));
    }
    #[test] fn second_operation_cannot_replace_an_owned_pending_render() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        let mut next = t.clone(); next.id = "host-request-b".into();
        assert_eq!(gate.begin(next), Err("unavailable")); assert_eq!(gate.acknowledge(&t), Ok(()));
        assert_eq!(gate.wait(&t, deadline()), Ok(()));
    }
    #[test] fn capture_state_token_rejects_changed_generation_value_or_sequence() {
        let t = ticket(); assert!(t.matches_state(2, 7, 9));
        assert!(!t.matches_state(3, 7, 9)); assert!(!t.matches_state(2, 8, 9)); assert!(!t.matches_state(2, 7, 10));
    }
    #[test] fn acknowledgement_cannot_extend_the_aggregate_deadline() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        gate.acknowledge(&t).unwrap();
        assert_eq!(gate.wait(&t, Instant::now()), Err("unavailable"));
        assert_eq!(gate.acknowledge(&t), Err("denied"));
    }
    #[test] fn request_failure_retires_only_its_own_pending_ticket() {
        let gate = RenderGate::default(); let t = ticket(); gate.ready().unwrap(); gate.begin(t.clone()).unwrap();
        gate.abandon_request(&t.id, t.generation - 1).unwrap(); gate.abandon_request("other", t.generation).unwrap();
        assert_eq!(gate.acknowledge(&t), Ok(())); gate.abandon_request(&t.id, t.generation).unwrap();
        assert_eq!(gate.wait(&t, deadline()), Err("cancelled"));
        assert_eq!(gate.acknowledge(&t), Err("denied"));
    }
}
