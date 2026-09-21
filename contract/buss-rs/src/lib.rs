//! The Passport account-recovery v1 profile over the upstream scheme
//! library. The scheme itself (BUSS / ANARKey over BLS12-381) is
//! `arc-pleiades`, re-exported here at the pinned revision; this crate adds
//! only what the recovery MIP specifies on top of it.

pub use arc_pleiades;
pub mod v1;
