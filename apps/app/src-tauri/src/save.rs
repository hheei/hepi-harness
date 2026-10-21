//! Saving one file from the workbench to a destination the person chose.
//!
//! A Web page does not need this: it navigates, and the browser streams the file to disk under its own name. A packaged
//! App cannot, because its document is a bundle on `tauri://localhost` — a navigation would ask the shell for a file it
//! does not serve, and no element of the page can present the device bearer. So the save is here, in the shell, and the
//! page hands it bytes it has already read through the connection.
//!
//! Three properties are this module's whole job, and each is a measurement rather than a preference (ticket 04):
//!
//! - **Nothing is collected.** The page slices the body to at most 1 MiB per call and awaits each slice, so the process
//!   holds one slice at a time. Handing over the WebView's own 69–73 MB chunk instead peaked at ~3.02 GB RSS for a 96 MiB
//!   file; 1 MiB slices saved the same bytes at ~225 MB.
//! - **A partial file is this run's own.** `begin` opens the destination, `abort` closes it and removes it, and a save
//!   whose handle is dropped without `finish` is removed by the same path. The source is never written: this module only
//!   ever creates the destination the picker answered.
//! - **Nothing is retried.** A failed append is reported as it happened. The bytes came from a read the page performed,
//!   and re-running the write would be a second write to a file the person is looking at.
//!
//! The destination is fixed at `begin`: the handle names one open file, so a page that switched view, workspace or
//! connection mid-save cannot redirect the rest of the bytes anywhere else.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The most one call may hand over.
///
/// The page already slices to this bound, and the check here is the second half of the same promise: a caller that got it
/// wrong is refused instead of quietly being allowed to grow the process. It is not a limit on the file.
pub const MAX_SAVE_CHUNK_BYTES: usize = 1024 * 1024;

/// One save in flight: the file it opened, the destination it opened, and how much it has written.
struct OpenSave {
    file: File,
    path: PathBuf,
    written: u64,
}

/// Every save this process is performing, keyed by the handle the page was given.
///
/// A handle is process-unique and is never reused, so a page that reuses a stale one after `finish` or `abort` is told
/// the save is not open rather than appending into a file that belongs to a later save.
#[derive(Default)]
pub struct Saves {
    open: Mutex<HashMap<u64, OpenSave>>,
    next: Mutex<u64>,
}

impl Saves {
    fn next_handle(&self) -> Result<u64, String> {
        let mut next = self.next.lock().map_err(|_| "the save registry is unavailable".to_string())?;
        *next += 1;
        Ok(*next)
    }
}

/// One destination the picker answered.
#[derive(serde::Serialize)]
pub struct ChosenDestination {
    path: String,
    overwrite: bool,
}

/// Open one destination and answer this save's handle.
///
/// The file is created only here, after the read was admitted: a refused read therefore never leaves an empty
/// destination behind. `overwrite` is the picker's own confirmation, so a file that exists is truncated only when the
/// person said so; a destination this save did not create is never removed by `abort`.
fn begin_save(saves: &Saves, path: &str, overwrite: bool) -> Result<u64, String> {
    if path.trim().is_empty() {
        return Err("a save needs a destination".into());
    }
    let destination = Path::new(path);
    if destination.is_dir() {
        return Err("that destination is a directory".into());
    }
    if destination.exists() && !overwrite {
        return Err("that file already exists and was not confirmed for replacement".into());
    }
    let file = File::create(destination).map_err(|error| format!("the destination could not be opened: {error}"))?;
    let handle = saves.next_handle()?;
    saves
        .open
        .lock()
        .map_err(|_| "the save registry is unavailable".to_string())?
        .insert(handle, OpenSave { file, path: destination.to_path_buf(), written: 0 });
    Ok(handle)
}

/// Append one slice and answer the file's length afterwards.
fn append_save(saves: &Saves, handle: u64, chunk: &[u8]) -> Result<u64, String> {
    if chunk.len() > MAX_SAVE_CHUNK_BYTES {
        return Err(format!("a save slice may be at most {MAX_SAVE_CHUNK_BYTES} bytes"));
    }
    let mut open = saves.open.lock().map_err(|_| "the save registry is unavailable".to_string())?;
    let save = open.get_mut(&handle).ok_or_else(|| "that save is not open".to_string())?;
    save.file.write_all(chunk).map_err(|error| format!("the destination could not be written: {error}"))?;
    save.written += chunk.len() as u64;
    Ok(save.written)
}

/// Flush the destination to the platform and close it.
fn finish_save(saves: &Saves, handle: u64) -> Result<u64, String> {
    let mut open = saves.open.lock().map_err(|_| "the save registry is unavailable".to_string())?;
    let save = open.remove(&handle).ok_or_else(|| "that save is not open".to_string())?;
    let mut file = save.file;
    file.flush().map_err(|error| format!("the destination could not be flushed: {error}"))?;
    // The bytes are on the platform's own device before the page is told the save finished: a file that is only in this
    // process's buffer when the App exits is not a saved file.
    file.sync_all().map_err(|error| format!("the destination could not be committed: {error}"))?;
    Ok(save.written)
}

/// Abandon one save: close the file and remove what this run wrote.
///
/// Repeating it changes nothing — a handle that is already closed is answered as closed rather than as a failure, because
/// the caller's own abort may race the page's cancellation.
fn abort_save(saves: &Saves, handle: u64) -> Result<(), String> {
    let mut open = saves.open.lock().map_err(|_| "the save registry is unavailable".to_string())?;
    let Some(save) = open.remove(&handle) else { return Ok(()) };
    drop(save.file);
    match std::fs::remove_file(&save.path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("the partial file could not be removed: {error}")),
    }
}

/// Ask the platform where this file should go, under the name it has on the host.
///
/// `None` is a closed dialog, which is not a failure: nothing was opened and nothing is transferred. The dialog runs on
/// the main thread because that is where the platform's own dialog must live; the command itself is async so the
/// WebView's IPC is not blocked while a person decides.
#[tauri::command]
pub async fn app_save_choose(app: tauri::AppHandle, suggested_name: String) -> Result<Option<ChosenDestination>, String> {
    let window = app.get_webview_window("main");
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file().set_title("Save file");
    if !suggested_name.trim().is_empty() {
        builder = builder.set_file_name(suggested_name.trim());
    }
    if let Some(window) = window.clone() {
        builder = builder.set_parent(&window);
    }
    builder.save_file(move |chosen| {
        // A dialog answered after the page stopped waiting is nobody's file: the send failing is the whole handling.
        let _ = sender.send(chosen);
    });
    let chosen = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok())
        .await
        .map_err(|error| format!("the save dialog did not answer: {error}"))?
        .flatten();
    let Some(chosen) = chosen else { return Ok(None) };
    let path = chosen.into_path().map_err(|error| format!("the chosen destination is not a file path: {error}"))?;
    // Whether the person is replacing a file is the platform's answer, taken before anything is opened: the dialog has
    // already asked them, so this is recorded rather than asked a second time in this client's own words.
    let overwrite = path.exists();
    Ok(Some(ChosenDestination { path: path.to_string_lossy().into_owned(), overwrite }))
}

/// Open the destination the picker answered.
#[tauri::command]
pub fn app_save_begin(saves: State<'_, Saves>, path: String, overwrite: bool) -> Result<u64, String> {
    begin_save(&saves, &path, overwrite)
}

/// Append one bounded slice.
#[tauri::command]
pub fn app_save_append(saves: State<'_, Saves>, handle: u64, chunk: Vec<u8>) -> Result<u64, String> {
    append_save(&saves, handle, &chunk)
}

/// Finish the file: flush it to the platform and close it.
#[tauri::command]
pub fn app_save_finish(saves: State<'_, Saves>, handle: u64) -> Result<u64, String> {
    finish_save(&saves, handle)
}

/// Abandon one save and remove the partial file this run wrote.
#[tauri::command]
pub fn app_save_abort(saves: State<'_, Saves>, handle: u64) -> Result<(), String> {
    abort_save(&saves, handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory this test owns, so nothing here touches a file a person already has.
    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("hepi-save-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_file_is_written_in_slices_and_reports_the_bytes_it_holds() {
        let directory = scratch("whole");
        let target = directory.join("file.bin");
        let saves = Saves::default();
        let handle = begin_save(&saves, target.to_str().unwrap(), false).unwrap();
        assert_eq!(append_save(&saves, handle, &[1, 2, 3]).unwrap(), 3);
        assert_eq!(append_save(&saves, handle, &[4, 5]).unwrap(), 5);
        assert_eq!(finish_save(&saves, handle).unwrap(), 5);
        assert_eq!(std::fs::read(&target).unwrap(), vec![1, 2, 3, 4, 5]);
        // The handle is closed: a later append is refused rather than written into a file a later save may own.
        assert!(append_save(&saves, handle, &[6]).is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_slice_past_the_bound_is_refused_before_it_is_written() {
        let directory = scratch("bound");
        let target = directory.join("file.bin");
        let saves = Saves::default();
        let handle = begin_save(&saves, target.to_str().unwrap(), false).unwrap();
        let oversized = vec![0u8; MAX_SAVE_CHUNK_BYTES + 1];
        assert!(append_save(&saves, handle, &oversized).is_err());
        assert_eq!(std::fs::metadata(&target).unwrap().len(), 0, "a refused slice wrote nothing");
        assert_eq!(append_save(&saves, handle, &vec![0u8; MAX_SAVE_CHUNK_BYTES]).unwrap(), MAX_SAVE_CHUNK_BYTES as u64);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_aborted_save_removes_only_the_file_it_opened() {
        let directory = scratch("abort");
        let target = directory.join("partial.bin");
        let neighbour = directory.join("not-mine.bin");
        std::fs::write(&neighbour, b"keep me").unwrap();
        let saves = Saves::default();
        let handle = begin_save(&saves, target.to_str().unwrap(), false).unwrap();
        append_save(&saves, handle, &[1, 2, 3, 4]).unwrap();
        abort_save(&saves, handle).unwrap();
        assert!(!target.exists(), "the partial file this run wrote is gone");
        assert_eq!(std::fs::read(&neighbour).unwrap(), b"keep me", "a file this save did not open is untouched");
        // Repeating it changes nothing, because a cancellation may race the page's own abort.
        abort_save(&saves, handle).unwrap();
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_existing_file_is_only_replaced_when_the_picker_said_so() {
        let directory = scratch("overwrite");
        let target = directory.join("existing.txt");
        std::fs::write(&target, b"the person's own file").unwrap();
        let saves = Saves::default();
        // Unconfirmed: refused, and the file is exactly as it was.
        assert!(begin_save(&saves, target.to_str().unwrap(), false).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"the person's own file");
        // Confirmed: replaced, because the dialog already asked them.
        let handle = begin_save(&saves, target.to_str().unwrap(), true).unwrap();
        append_save(&saves, handle, b"new").unwrap();
        finish_save(&saves, handle).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_destination_that_is_a_directory_is_refused_rather_than_truncated() {
        let directory = scratch("directory");
        let saves = Saves::default();
        assert!(begin_save(&saves, directory.to_str().unwrap(), true).is_err());
        assert!(begin_save(&saves, "", true).is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
