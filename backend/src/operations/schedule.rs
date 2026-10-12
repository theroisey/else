//! Calendar-based recurrence; local dates are never approximated by UTC durations.
use crate::error::{Error, Result};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc,
};
use chrono_tz::Tz;
pub fn zone(value: &str) -> Result<Tz> {
    if value == "Local" {
        return Err(Error::Invalid("invalid_schedule"));
    }
    value
        .parse()
        .map_err(|_| Error::Invalid("invalid_schedule"))
}
pub fn today(timezone: &str) -> Result<NaiveDate> {
    Ok(Utc::now().with_timezone(&zone(timezone)?).date_naive())
}
pub fn date(value: &str) -> Result<NaiveDate> {
    crate::validation::date(value)?;
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| Error::Invalid("invalid_schedule"))
}
fn bounded(value: NaiveDate) -> Result<NaiveDate> {
    if !(1..=9999).contains(&value.year()) {
        return Err(Error::Invalid("invalid_schedule"));
    }
    Ok(value)
}
fn month(index: i32, day: u32) -> Result<NaiveDate> {
    if !(1..=31).contains(&day) {
        return Err(Error::Invalid("invalid_schedule"));
    }
    let year = index.div_euclid(12);
    if !(1..=9999).contains(&year) {
        return Err(Error::Invalid("invalid_schedule"));
    }
    let month = index.rem_euclid(12) as u32 + 1;
    let first =
        NaiveDate::from_ymd_opt(year, month, 1).ok_or(Error::Invalid("invalid_schedule"))?;
    let next = first
        .checked_add_months(chrono::Months::new(1))
        .ok_or(Error::Invalid("invalid_schedule"))?;
    let last = next.pred_opt().ok_or(Error::Internal)?.day();
    first.with_day(day.min(last)).ok_or(Error::Internal)
}
pub fn next(
    current: NaiveDate,
    frequency: &str,
    interval: u32,
    anchor_day: u32,
) -> Result<NaiveDate> {
    if !(1..=365).contains(&interval) {
        return Err(Error::Invalid("invalid_schedule"));
    }
    let result = match frequency {
        "daily" => current
            .checked_add_signed(Duration::days(i64::from(interval)))
            .ok_or(Error::Invalid("invalid_schedule")),
        "weekly" => current
            .checked_add_signed(Duration::days(i64::from(interval) * 7))
            .ok_or(Error::Invalid("invalid_schedule")),
        "monthly" => month(
            current.year() * 12
                + current.month0() as i32
                + i32::try_from(interval).map_err(|_| Error::Invalid("invalid_schedule"))?,
            anchor_day,
        ),
        _ => Err(Error::Invalid("invalid_schedule")),
    }?;
    bounded(result)
}
pub fn on_or_after(
    start: NaiveDate,
    boundary: NaiveDate,
    frequency: &str,
    interval: u32,
    anchor_day: u32,
) -> Result<NaiveDate> {
    if !(1..=365).contains(&interval) {
        return Err(Error::Invalid("invalid_schedule"));
    }
    if boundary <= start {
        return bounded(start);
    }
    let result = match frequency {
        "daily" | "weekly" => {
            let days = (boundary - start).num_days();
            let step = i64::from(interval) * if frequency == "weekly" { 7 } else { 1 };
            let periods = days.checked_add(step - 1).ok_or(Error::Internal)? / step;
            start
                .checked_add_signed(Duration::days(
                    periods.checked_mul(step).ok_or(Error::Internal)?,
                ))
                .ok_or(Error::Invalid("invalid_schedule"))
        }
        "monthly" => {
            let origin = start.year() * 12 + start.month0() as i32;
            let target = boundary.year() * 12 + boundary.month0() as i32;
            let step = i32::try_from(interval).map_err(|_| Error::Invalid("invalid_schedule"))?;
            let at = origin + (target - origin) / step * step;
            let candidate = month(at, anchor_day)?;
            if candidate < boundary {
                month(at + step, anchor_day)
            } else {
                Ok(candidate)
            }
        }
        _ => Err(Error::Invalid("invalid_schedule")),
    }?;
    bounded(result)
}
pub fn due(date: NaiveDate, time: &str, timezone: &str) -> Result<String> {
    if time.len() != 5 {
        return Err(Error::Invalid("invalid_schedule"));
    }
    let local = date.and_time(
        NaiveTime::parse_from_str(time, "%H:%M").map_err(|_| Error::Invalid("invalid_schedule"))?,
    );
    let zone = zone(timezone)?;
    // Includes historical date-line jumps. The work is bounded, including gaps.
    for minutes in 0..=1560 {
        let at = local
            .checked_add_signed(Duration::minutes(minutes))
            .ok_or(Error::Invalid("invalid_schedule"))?;
        let result: Option<DateTime<Tz>> = match zone.from_local_datetime(&at) {
            LocalResult::Single(v) => Some(v),
            LocalResult::Ambiguous(a, b) => Some(a.min(b)),
            LocalResult::None => None,
        };
        if let Some(v) = result {
            return crate::validation::instant(
                &v.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Micros, true),
            );
        }
    }
    Err(Error::Invalid("invalid_schedule"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_anchor_returns_after_short_and_leap_months() {
        for (year, february) in [
            (2024, "2024-02-29"),
            (2025, "2025-02-28"),
            (2026, "2026-02-28"),
        ] {
            let january = date(&format!("{year}-01-31")).unwrap();
            let feb = next(january, "monthly", 1, 31).unwrap();
            assert_eq!(feb.to_string(), february);
            assert_eq!(
                next(feb, "monthly", 1, 31).unwrap().to_string(),
                format!("{year}-03-31")
            );
        }
        assert_eq!(
            next(date("2026-04-30").unwrap(), "monthly", 1, 31)
                .unwrap()
                .to_string(),
            "2026-05-31"
        );
    }
    #[test]
    fn resume_is_prospective_and_preserves_the_interval_anchor() {
        let start = date("2026-01-31").unwrap();
        assert_eq!(
            on_or_after(start, date("2026-03-01").unwrap(), "monthly", 1, 31)
                .unwrap()
                .to_string(),
            "2026-03-31"
        );
        assert_eq!(
            on_or_after(start, date("2026-02-28").unwrap(), "monthly", 1, 31)
                .unwrap()
                .to_string(),
            "2026-02-28"
        );
        assert_eq!(
            on_or_after(
                date("2026-01-05").unwrap(),
                date("2026-01-13").unwrap(),
                "weekly",
                2,
                5
            )
            .unwrap()
            .to_string(),
            "2026-01-19"
        );
        assert_eq!(
            on_or_after(
                date("2026-01-01").unwrap(),
                date("2026-01-06").unwrap(),
                "daily",
                2,
                1
            )
            .unwrap()
            .to_string(),
            "2026-01-07"
        );
    }
    #[test]
    fn daylight_saving_gap_and_fold_use_documented_policy() {
        assert_eq!(
            due(date("2026-03-29").unwrap(), "03:30", "Europe/Bucharest").unwrap(),
            "2026-03-29T01:00:00.000000Z"
        );
        assert_eq!(
            due(date("2026-10-25").unwrap(), "03:30", "Europe/Bucharest").unwrap(),
            "2026-10-25T00:30:00.000000Z"
        );
        assert_eq!(
            due(date("2011-12-30").unwrap(), "09:00", "Pacific/Apia").unwrap(),
            "2011-12-30T10:00:00.000000Z"
        );
        assert!(zone("Local").is_err());
        assert!(due(date("2026-10-11").unwrap(), "25:00", "UTC").is_err());
    }
    #[test]
    fn daily_due_times_follow_local_clock_across_dst() {
        let a = due(date("2026-03-28").unwrap(), "09:00", "Europe/Bucharest").unwrap();
        let b = due(date("2026-03-29").unwrap(), "09:00", "Europe/Bucharest").unwrap();
        assert_eq!(a, "2026-03-28T07:00:00.000000Z");
        assert_eq!(b, "2026-03-29T06:00:00.000000Z");
        assert_eq!(
            next(date("2026-10-11").unwrap(), "weekly", 1, 11)
                .unwrap()
                .to_string(),
            "2026-10-18"
        );
    }
    #[test]
    fn recurrence_rejects_dates_outside_the_canonical_storage_range() {
        for frequency in ["daily", "weekly", "monthly"] {
            assert!(next(date("9999-12-31").unwrap(), frequency, 1, 31).is_err());
        }
        assert!(
            on_or_after(
                date("9999-12-20").unwrap(),
                date("9999-12-31").unwrap(),
                "weekly",
                2,
                20
            )
            .is_err()
        );
        assert!(due(date("0001-01-01").unwrap(), "00:00", "Europe/Bucharest").is_err());
    }
}
