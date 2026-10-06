//! Trusted operator paths only. Private, single-link regular files and atomic
//! no-replace publication keep recovery artifacts separate from live data.
use crate::error::{Error, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path},
};
use zeroize::Zeroizing;
pub fn path(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return Err(Error::Invalid("invalid_operator_path"));
    }
    Ok(())
}
pub fn directory(path: &Path, create: bool) -> Result<()> {
    self::path(path)?;
    if create {
        match fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
        {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(Error::Internal),
        }
    }
    let stat = path.symlink_metadata().map_err(|_| Error::Internal)?;
    let uid = unsafe { libc::geteuid() };
    if !stat.is_dir()
        || stat.file_type().is_symlink()
        || stat.mode() & 0o077 != 0
        || (stat.uid() != uid && stat.uid() != 0)
    {
        return Err(Error::Internal);
    }
    Ok(())
}
pub fn read(path: &Path, max: usize) -> Result<Zeroizing<Vec<u8>>> {
    self::path(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| Error::Internal)?;
    let before = file.metadata().map_err(|_| Error::Internal)?;
    let uid = unsafe { libc::geteuid() };
    if !before.is_file()
        || before.nlink() != 1
        || !matches!(before.mode() & 0o7777, 0o400 | 0o600)
        || (before.uid() != uid && before.uid() != 0)
        || before.len() > max as u64
    {
        return Err(Error::Internal);
    }
    let mut raw = Zeroizing::new(Vec::new());
    Read::by_ref(&mut file)
        .take((max + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|_| Error::Internal)?;
    let after = file.metadata().map_err(|_| Error::Internal)?;
    if raw.len() > max
        || (
            before.dev(),
            before.ino(),
            before.len(),
            before.mode(),
            before.uid(),
            before.nlink(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.dev(),
            after.ino(),
            after.len(),
            after.mode(),
            after.uid(),
            after.nlink(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        )
    {
        return Err(Error::Internal);
    }
    Ok(raw)
}
pub fn write(path: &Path, raw: &[u8], mode: u32) -> Result<()> {
    self::path(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| Error::Internal)?;
    file.write_all(raw)
        .and_then(|_| file.sync_all())
        .map_err(|_| Error::Internal)
}
pub fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::Internal)
}
pub fn publish(source: &Path, destination: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    self::path(source)?;
    self::path(destination)?;
    let from = CString::new(source.as_os_str().as_bytes()).map_err(|_| Error::Internal)?;
    let to = CString::new(destination.as_os_str().as_bytes()).map_err(|_| Error::Internal)?;
    if unsafe {
        // Linux's atomic no-replace operation is available through the syscall
        // even on musl, which does not expose the glibc renameat2 wrapper.
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(Error::Conflict("destination_exists_or_unavailable"));
    }
    sync_directory(destination.parent().ok_or(Error::Internal)?)
}
/// Serving and offline recovery are mutually exclusive for this data directory.
pub struct RuntimeLease(File);
impl RuntimeLease {
    pub fn acquire(database: &Path) -> Result<Self> {
        let directory = database.parent().ok_or(Error::Internal)?.join(".control");
        self::directory(&directory, true)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(directory.join("runtime.lock"))
            .map_err(|_| Error::Internal)?;
        let stat = file.metadata().map_err(|_| Error::Internal)?;
        if !stat.is_file() || stat.nlink() != 1 || stat.mode() & 0o077 != 0 {
            return Err(Error::Internal);
        }
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error::Conflict("application_is_running"));
        }
        Ok(Self(file))
    }
}
impl Drop for RuntimeLease {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}
