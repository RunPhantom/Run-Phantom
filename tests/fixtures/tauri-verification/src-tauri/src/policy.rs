pub const APPLICATION: &str = "dev.runphantom.tauri-fixture";
pub const WINDOW: &str = "verification-fixture";

pub struct Policy {
    nonce: String,
    pub generation: u64,
    pub value: i64,
    pub sequence: u64,
}
impl Policy {
    pub fn new(nonce: String) -> Result<Self, &'static str> {
        if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err("denied");
        }
        Ok(Self { nonce, generation: 0, value: 0, sequence: 0 })
    }
    pub fn authorize(&self, application: &str, window: &str, nonce: &str, generation: u64) -> Result<(), &'static str> {
        if application != APPLICATION || window != WINDOW || nonce != self.nonce { return Err("denied"); }
        if generation != self.generation { return Err("cancelled"); }
        Ok(())
    }
    pub fn cancel(&mut self, application: &str, window: &str, nonce: &str, generation: u64) -> Result<(), &'static str> {
        if application != APPLICATION || window != WINDOW || nonce != self.nonce { return Err("denied"); }
        if generation <= self.generation || generation > 9_007_199_254_740_991 { return Err("cancelled"); }
        self.generation = generation; Ok(())
    }
    pub fn action(&mut self, action: &str) -> Result<(), &'static str> {
        self.value = match action { "increment" => self.value.checked_add(1).ok_or("unavailable")?, "reset" => 0, _ => return Err("denied") };
        self.sequence = self.sequence.checked_add(1).filter(|n| *n <= 9_007_199_254_740_991).ok_or("unavailable")?;
        Ok(())
    }
    pub fn capture(mode: &str, consent: bool) -> Result<(), &'static str> {
        if mode == "private-raw" && consent { Ok(()) } else { Err("denied") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> Policy { Policy::new("a".repeat(64)).unwrap() }
    #[test] fn authority_is_exact() {
        let p = policy();
        assert_eq!(p.authorize(APPLICATION, WINDOW, &"a".repeat(64), 0), Ok(()));
        for (app, win, nonce) in [("foreign", WINDOW, "a".repeat(64)), (APPLICATION, "other", "a".repeat(64)), (APPLICATION, WINDOW, "b".repeat(64))] {
            assert_eq!(p.authorize(app, win, &nonce, 0), Err("denied"));
        }
    }
    #[test] fn generation_cancels_stale_requests_without_granting_a_foreign_owner() {
        let mut p = policy();
        assert_eq!(p.cancel(APPLICATION, WINDOW, &"b".repeat(64), 1), Err("denied"));
        assert_eq!(p.generation, 0);
        assert_eq!(p.cancel(APPLICATION, WINDOW, &"a".repeat(64), 2), Ok(()));
        assert_eq!(p.authorize(APPLICATION, WINDOW, &"a".repeat(64), 0), Err("cancelled"));
        assert_eq!(p.cancel(APPLICATION, WINDOW, &"a".repeat(64), 2), Err("cancelled"));
    }
    #[test] fn only_fixed_cooperating_actions_change_the_fixture() {
        let mut p = policy();
        assert_eq!(p.action("shell"), Err("denied")); assert_eq!((p.value, p.sequence), (0, 0));
        p.action("increment").unwrap(); assert_eq!((p.value, p.sequence), (1, 1));
        p.action("reset").unwrap(); assert_eq!((p.value, p.sequence), (0, 2));
    }
    #[test] fn raw_capture_needs_both_explicit_mode_and_consent() {
        assert_eq!(Policy::capture("private-raw", true), Ok(()));
        assert_eq!(Policy::capture("private-raw", false), Err("denied"));
        assert_eq!(Policy::capture("masked", true), Err("denied"));
        assert!(Policy::new("credential-canary".into()).is_err());
    }
}
