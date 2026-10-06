use http::StatusCode;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("method not allowed")]
    Method(&'static str),
    #[error("request rejected")]
    Response(StatusCode, &'static str, &'static str),
    #[error("invalid request")]
    Invalid(&'static str),
    #[error("authentication required")]
    Unauthorized,
    #[error("permission denied")]
    Denied,
    #[error("resource not found")]
    NotFound,
    #[error("state conflict")]
    Conflict(&'static str),
    #[error("service busy")]
    Busy,
    #[error("internal failure")]
    Internal,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Method(_) => StatusCode::METHOD_NOT_ALLOWED,
            Self::Response(status, _, _) => *status,
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Denied => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Busy => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Method(_) => "method_not_allowed",
            Self::Response(_, code, _) => code,
            Self::Invalid(code) | Self::Conflict(code) => code,
            Self::Unauthorized => "authentication_required",
            Self::Denied => "permission_denied",
            Self::NotFound => "not_found",
            Self::Busy => "service_unavailable",
            Self::Internal => "internal_error",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::Method(_) => "Method not allowed.",
            Self::Response(_, _, message) => message,
            Self::Invalid(_) => "Request is invalid.",
            Self::Unauthorized => "Authentication is required.",
            Self::Denied => "Permission denied.",
            Self::NotFound => "Resource not found.",
            Self::Conflict(_) => "Record changed or operation conflicts with its current state.",
            Self::Busy => "Service is temporarily unavailable. Retry shortly.",
            Self::Internal => "Request could not be completed.",
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        match value {
            rusqlite::Error::QueryReturnedNoRows => Self::NotFound,
            rusqlite::Error::SqliteFailure(ref code, _) => match code.code {
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                    Self::Busy
                }
                rusqlite::ErrorCode::ConstraintViolation => Self::Conflict("conflict"),
                _ => Self::Internal,
            },
            _ => Self::Internal,
        }
    }
}
