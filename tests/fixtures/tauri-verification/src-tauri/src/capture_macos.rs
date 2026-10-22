//! Private raw pixels of the actual Tauri-owned NSWindow only; no global display capture.
use std::ffi::{c_char, c_void};
type Ref = *const c_void;
#[repr(C)] #[derive(Clone, Copy)] struct Point { x: f64, y: f64 }
#[repr(C)] #[derive(Clone, Copy)] struct Size { width: f64, height: f64 }
#[repr(C)] #[derive(Clone, Copy)] struct Rect { origin: Point, size: Size }
#[link(name = "objc")] extern "C" {
    fn sel_registerName(name: *const c_char) -> Ref;
    fn objc_msgSend(receiver: *mut c_void, selector: Ref) -> isize;
}
#[link(name = "CoreGraphics", kind = "framework")] extern "C" {
    static CGRectNull: Rect;
    fn CGWindowListCreateImage(bounds: Rect, options: u32, window: u32, image_options: u32) -> Ref;
    fn CGImageGetWidth(image: Ref) -> usize;
    fn CGImageGetHeight(image: Ref) -> usize;
}
#[link(name = "CoreFoundation", kind = "framework")] extern "C" {
    fn CFDataCreateMutable(allocator: Ref, capacity: isize) -> *mut c_void;
    fn CFDataGetLength(data: Ref) -> isize;
    fn CFDataGetBytePtr(data: Ref) -> *const u8;
    fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
    fn CFRelease(object: Ref);
}
#[link(name = "ImageIO", kind = "framework")] extern "C" {
    fn CGImageDestinationCreateWithData(data: *mut c_void, kind: Ref, count: usize, options: Ref) -> Ref;
    fn CGImageDestinationAddImage(destination: Ref, image: Ref, properties: Ref);
    fn CGImageDestinationFinalize(destination: Ref) -> bool;
}
struct Owned(Ref);
impl Drop for Owned { fn drop(&mut self) { if !self.0.is_null() { unsafe { CFRelease(self.0); } } } }
/// Caller must be on the main thread and pass its live Tauri WebviewWindow's NSWindow.
pub unsafe fn capture_owned_window(window: *mut c_void) -> Result<Vec<u8>, &'static str> {
    if window.is_null() { return Err("unavailable"); }
    let number = objc_msgSend(window, sel_registerName(b"windowNumber\0".as_ptr().cast()));
    if number <= 0 || number > u32::MAX as isize { return Err("unavailable"); }
    // IncludingWindow (8) never requests the entire screen or another supplied window ID.
    let image = Owned(CGWindowListCreateImage(CGRectNull, 8, number as u32, 1));
    if image.0.is_null() { return Err("denied"); }
    let (width, height) = (CGImageGetWidth(image.0), CGImageGetHeight(image.0));
    if width == 0 || height == 0 || width > 1920 || height > 1080 { return Err("unavailable"); }
    let data = Owned(CFDataCreateMutable(std::ptr::null(), 0));
    let kind = Owned(CFStringCreateWithCString(std::ptr::null(), b"public.png\0".as_ptr().cast(), 0x08000100));
    if data.0.is_null() || kind.0.is_null() { return Err("unavailable"); }
    let destination = Owned(CGImageDestinationCreateWithData(data.0 as *mut c_void, kind.0, 1, std::ptr::null()));
    if destination.0.is_null() { return Err("unavailable"); }
    CGImageDestinationAddImage(destination.0, image.0, std::ptr::null());
    if !CGImageDestinationFinalize(destination.0) { return Err("unavailable"); }
    let length = CFDataGetLength(data.0);
    if length <= 0 || length > 8 * 1024 * 1024 { return Err("unavailable"); }
    let bytes = CFDataGetBytePtr(data.0);
    if bytes.is_null() { return Err("unavailable"); }
    Ok(std::slice::from_raw_parts(bytes, length as usize).to_vec())
}
