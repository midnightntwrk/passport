use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Error {
    #[error("insufficient shares: need {need}, got {got}")]
    InsufficientShares { need: usize, got: usize },

    #[error("got invalid share")]
    InvalidShares,

    #[error("invalid polynomial degree: need {need}, got {got}")]
    InvalidDegree { need: usize, got: usize },

    #[error("duplicate x-coordinate in share set")]
    DuplicateXCoordinate,

    #[error("share verification failed")]
    VerificationFailed,

    #[error("invalid parameters: {0}")]
    InvalidParameters(String),

    #[error("tracing error: {0}")]
    TracingError(String),

    #[error("trace verification error: {0}")]
    TracingVerificationError(String),
}
