//! Whether a disruption budget can ever allow an eviction.

/// With every pod it selects healthy, still none to spare: a drain waits on
/// it for good. `src/contracts/budget-verdict-conformance.json` holds the
/// answers, and `cannotAllowOf` in `src/ui/lib/governance.ts` owes them too.
#[must_use]
pub fn cannot_allow(desired_healthy: i32, expected_pods: i32) -> bool {
    expected_pods > 0 && desired_healthy >= expected_pods
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The budget's own page reads the raw object in TypeScript and every
    /// other screen reads this. Fails when the two answers drift apart.
    #[test]
    fn every_budget_in_the_shared_corpus_answers_the_same() {
        const CORPUS: &str = include_str!("../../../contracts/budget-verdict-conformance.json");
        let corpus: serde_json::Value = serde_json::from_str(CORPUS).unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert!(cases.len() >= 6, "the corpus lost its cases");
        for case in cases {
            let at = |field: &str| i32::try_from(case[field].as_i64().unwrap()).unwrap();
            assert_eq!(
                cannot_allow(at("desiredHealthy"), at("expectedPods")),
                case["cannotAllow"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
