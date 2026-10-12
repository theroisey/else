//! Exact allocation of collected funds; internal transfers never bill a customer.
use crate::error::{Error, Result};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub contracted: i64,
    pub roise_contract: i64,
    pub partner_contract: i64,
    pub collected: i64,
    pub customer_outstanding: i64,
    pub roise_recognized: i64,
    pub partner_recognized: i64,
    pub internal_due_to_roise: i128,
    pub transferred_to_roise: i128,
    pub remaining_to_roise: i128,
}
pub struct Funds {
    pub total: i64,
    pub roise_share: i64,
    pub collected: i64,
    pub roise_collected: i64,
    pub collector_is_roise: bool,
    pub contractual: bool,
    pub transferred_to_roise: i128,
}
pub fn position(f: Funds) -> Result<Position> {
    if f.total <= 0
        || f.roise_share < 0
        || f.roise_share > f.total
        || f.collected < 0
        || f.collected > f.total
        || f.roise_collected < 0
        || f.roise_collected > f.collected
    {
        return Err(Error::Invalid("invalid_allocation"));
    }
    let recognized = if f.contractual {
        f.roise_share
    } else {
        let value = i128::from(f.collected)
            .checked_mul(i128::from(f.roise_share))
            .and_then(|v| v.checked_add(i128::from(f.total) / 2))
            .ok_or(Error::Internal)?
            / i128::from(f.total);
        i64::try_from(value).map_err(|_| Error::Internal)?
    };
    let recognized_total = if f.contractual { f.total } else { f.collected };
    let unfunded_roise = if f.contractual && f.collector_is_roise {
        f.total - f.collected
    } else {
        0
    };
    let due = i128::from(recognized) - i128::from(f.roise_collected) - i128::from(unfunded_roise);
    let remaining = due
        .checked_sub(f.transferred_to_roise)
        .ok_or(Error::Internal)?;
    Ok(Position {
        contracted: f.total,
        roise_contract: f.roise_share,
        partner_contract: f.total - f.roise_share,
        collected: f.collected,
        customer_outstanding: f.total - f.collected,
        roise_recognized: recognized,
        partner_recognized: recognized_total - recognized,
        internal_due_to_roise: due,
        transferred_to_roise: f.transferred_to_roise,
        remaining_to_roise: remaining,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn consulting(collected: i64, roise_collected: i64, transferred: i128) -> Position {
        position(Funds {
            total: 70000,
            roise_share: 20000,
            collected,
            roise_collected,
            collector_is_roise: false,
            contractual: false,
            transferred_to_roise: transferred,
        })
        .unwrap()
    }
    #[test]
    fn full_and_partial_collections_and_settlements_preserve_one_customer_charge() {
        let a = consulting(70000, 0, 0);
        assert_eq!(a.customer_outstanding, 0);
        assert_eq!(a.remaining_to_roise, 20000);
        assert_eq!(a.roise_contract + a.partner_contract, a.contracted);
        assert_eq!(consulting(70000, 0, 20000).remaining_to_roise, 0);
        let b = consulting(70000, 70000, 0);
        assert_eq!(b.remaining_to_roise, -50000);
        assert_eq!(consulting(70000, 70000, -50000).remaining_to_roise, 0);
        let c = consulting(35000, 0, 0);
        assert_eq!(c.customer_outstanding, 35000);
        assert_eq!(c.roise_recognized, 10000);
        assert_eq!(c.partner_recognized, 25000);
        assert_eq!(c.remaining_to_roise, 10000);
        assert_eq!(consulting(35000, 35000, 0).remaining_to_roise, -25000);
        assert_eq!(consulting(70000, 20000, 0).remaining_to_roise, 0);
    }
    #[test]
    fn refunds_preserve_prior_transfers_and_can_reverse_internal_direction() {
        assert_eq!(consulting(35000, 0, 20000).remaining_to_roise, -10000);
        assert_eq!(consulting(35000, 35000, -50000).remaining_to_roise, 25000);
        assert_eq!(consulting(0, 0, 20000).remaining_to_roise, -20000);
    }
    #[test]
    fn software_usd_balance_is_independent_of_consulting_eur() {
        let software = position(Funds {
            total: 100000,
            roise_share: 100000,
            collected: 60000,
            roise_collected: 60000,
            collector_is_roise: true,
            contractual: false,
            transferred_to_roise: 0,
        })
        .unwrap();
        assert_eq!(software.customer_outstanding, 40000);
        assert_eq!(software.remaining_to_roise, 0);
        assert_eq!(consulting(35000, 0, 0).customer_outstanding, 35000);
    }
    #[test]
    fn contractual_policy_is_explicit_and_includes_unfunded_collector_responsibility() {
        for (collector_is_roise, expected) in [(false, 20000), (true, -50000)] {
            let a = position(Funds {
                total: 70000,
                roise_share: 20000,
                collected: 0,
                roise_collected: 0,
                collector_is_roise,
                contractual: true,
                transferred_to_roise: 0,
            })
            .unwrap();
            assert_eq!(a.remaining_to_roise, expected);
            assert_eq!(a.customer_outstanding, 70000);
            assert_eq!(a.roise_recognized + a.partner_recognized, 70000);
        }
    }
    #[test]
    fn aggregate_half_up_rounding_and_wide_intermediates_never_overallocate() {
        assert_eq!(consulting(1, 0, 0).roise_recognized, 0);
        assert_eq!(consulting(2, 0, 0).roise_recognized, 1);
        let a = position(Funds {
            total: i64::MAX,
            roise_share: i64::MAX,
            collected: i64::MAX,
            roise_collected: i64::MAX,
            collector_is_roise: true,
            contractual: false,
            transferred_to_roise: 0,
        })
        .unwrap();
        assert_eq!(a.roise_recognized, i64::MAX);
        assert_eq!(a.remaining_to_roise, 0);
        for collected in [0, 1, 2, 3, 34999, 35000, 69999, 70000] {
            let a = consulting(collected, 0, 0);
            assert_eq!(a.roise_recognized + a.partner_recognized, collected);
            assert!(a.roise_recognized <= 20000);
            assert!(a.partner_recognized <= 50000)
        }
        assert!(
            position(Funds {
                total: 70000,
                roise_share: 20000,
                collected: 70001,
                roise_collected: 0,
                collector_is_roise: false,
                contractual: false,
                transferred_to_roise: 0
            })
            .is_err()
        );
    }
}
