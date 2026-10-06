//! Safe operator diagnostics. Driver messages, SQL and private paths stay private.
use crate::error::Error;
use std::{
    fs, io,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::Path,
};

#[derive(Debug)]
pub struct Failure {
    pub stage: &'static str,
    pub code: &'static str,
    pub operation: Option<&'static str>,
    pub error_kind: Option<String>,
    pub errno: Option<i32>,
    pub owner_uid: Option<u32>,
    pub runtime_uid: Option<u32>,
    pub directory_mode: Option<String>,
}
impl Failure {
    pub fn new(stage: &'static str, code: &'static str) -> Self {
        Self {
            stage,
            code,
            operation: None,
            error_kind: None,
            errno: None,
            owner_uid: None,
            runtime_uid: None,
            directory_mode: None,
        }
    }
    pub fn io(
        stage: &'static str,
        code: &'static str,
        operation: &'static str,
        error: io::Error,
    ) -> Self {
        Self {
            stage,
            code,
            operation: Some(operation),
            error_kind: Some(format!("{:?}", error.kind())),
            errno: error.raw_os_error(),
            owner_uid: None,
            runtime_uid: None,
            directory_mode: None,
        }
    }
    pub fn domain(stage: &'static str, code: &'static str, error: Error) -> Self {
        // Explicit refusal codes (for example incomplete recovery) remain useful.
        Self::new(
            stage,
            if matches!(error, Error::Internal) {
                code
            } else {
                error.code()
            },
        )
    }
}
impl From<&'static str> for Failure {
    fn from(code: &'static str) -> Self {
        Self::new("operator", code)
    }
}

pub fn directory(path: &Path, stage: &'static str, code: &'static str) -> Result<(), Failure> {
    crate::private_files::path(path).map_err(|e| Failure::domain(stage, code, e))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|e| Failure::io(stage, code, "create_directory", e))?;
    let metadata = path
        .symlink_metadata()
        .map_err(|e| Failure::io(stage, code, "inspect_directory", e))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        let mut failure = Failure::new(stage, code);
        failure.operation = Some("validate_private_directory");
        failure.owner_uid = Some(metadata.uid());
        failure.runtime_uid = Some(unsafe { libc::geteuid() });
        failure.directory_mode = Some(format!("{:04o}", metadata.mode() & 0o7777));
        return Err(failure);
    }
    Ok(())
}
