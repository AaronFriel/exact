//! The icons' hidden window and what `Shell_NotifyIconW` is told.
#![allow(unsafe_code)]
use super::{Callback, CALLBACK};
use std::{cell::RefCell, rc::Rc};
use windows_sys::Win32::{
    Foundation::HWND,
    Graphics::Gdi::{
        CreateBitmap, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    },
    System::{
        LibraryLoader::GetModuleHandleW,
        Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
    },
    UI::{
        HiDpi::{GetDpiForSystem, GetSystemMetricsForDpi},
        Shell::{
            DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass, Shell_NotifyIconW, NIF_ICON,
            NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NIM_SETVERSION,
            NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
        },
        WindowsAndMessaging::{
            CreateIconIndirect, CreateWindowExW, DestroyIcon, DestroyWindow, DrawIconEx, LoadIconW,
            LoadImageW, RegisterWindowMessageW, DI_NORMAL, HICON, ICONINFO, IDI_APPLICATION,
            IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXSMICON, WM_NCDESTROY, WM_SETTINGCHANGE,
            WS_EX_TOOLWINDOW, WS_POPUP,
        },
    },
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// What the icons' window heard since the last [`Shell::take`].
pub(crate) enum Heard {
    /// An icon's callback.
    Callback(Callback),
    /// Explorer started again: no icon is shown.
    TaskbarCreated,
    /// The system's light or dark mode changed, which the taskbar follows.
    Theme,
}

#[derive(Default)]
struct State {
    heard: RefCell<Vec<Heard>>,
    wake: RefCell<Option<Box<dyn Fn()>>>,
    taskbar_created: u32,
}

/// The hidden top-level window the shell sends the icons' messages to, and
/// each icon shown, by id, with the `HICON` last given for it.
pub(crate) struct Shell {
    window: HWND,
    state: Rc<State>,
    icons: Vec<(u16, HICON)>,
}

impl Shell {
    /// The window, or `None` when it cannot be made (then no icon shows).
    pub(crate) fn new(name: &str) -> Option<Shell> {
        let class = wide("Static");
        let title = wide(name);
        let message = wide("TaskbarCreated");
        let state = Rc::new(State {
            taskbar_created: unsafe { RegisterWindowMessageW(message.as_ptr()) },
            ..Default::default()
        });
        // Never shown; a tool window has no taskbar button even if it were.
        let window = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        let data = Rc::into_raw(state.clone());
        // The window holds this reference until WM_NCDESTROY; it is used only
        // on this thread, whose event loop dispatches the window's messages.
        if window.is_null()
            || unsafe { SetWindowSubclass(window, Some(receive), 0, data as usize) } == 0
        {
            eprintln!(
                "exact-windows: notification area: {}",
                std::io::Error::last_os_error()
            );
            unsafe {
                drop(Rc::from_raw(data));
                if !window.is_null() {
                    DestroyWindow(window);
                }
            }
            return None;
        }
        Some(Shell {
            window,
            state,
            icons: Vec::new(),
        })
    }

    /// What wakes the event loop once the window hears something.
    pub(crate) fn set_wake(&self, wake: impl Fn() + 'static) {
        *self.state.wake.borrow_mut() = Some(Box::new(wake));
    }

    pub(crate) fn take(&self) -> Vec<Heard> {
        std::mem::take(&mut *self.state.heard.borrow_mut())
    }

    fn data(&self, id: u16) -> NOTIFYICONDATAW {
        let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = self.window;
        data.uID = u32::from(id);
        data
    }

    /// Show icon `id`, or show it anew, with `tip` and `icon`, which it then
    /// owns. Whether the shell took it.
    pub(crate) fn show(&mut self, id: u16, tip: [u16; 128], icon: HICON) -> bool {
        let mut data = self.data(id);
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        data.uCallbackMessage = CALLBACK;
        data.hIcon = icon;
        data.szTip = tip;
        let known = self.icons.iter().position(|(i, _)| *i == id);
        let told = match known {
            Some(_) => unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) != 0 },
            None => {
                let added = unsafe { Shell_NotifyIconW(NIM_ADD, &data) != 0 };
                data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
                added && unsafe { Shell_NotifyIconW(NIM_SETVERSION, &data) != 0 }
            }
        };
        match known {
            Some(at) => unsafe {
                DestroyIcon(std::mem::replace(&mut self.icons[at].1, icon));
            },
            None if told => self.icons.push((id, icon)),
            None => unsafe {
                DestroyIcon(icon);
            },
        }
        told
    }

    /// Remove icon `id`.
    pub(crate) fn remove(&mut self, id: u16) {
        let Some(at) = self.icons.iter().position(|(i, _)| *i == id) else {
            return;
        };
        let (_, icon) = self.icons.remove(at);
        let data = self.data(id);
        unsafe {
            Shell_NotifyIconW(NIM_DELETE, &data);
            DestroyIcon(icon);
        }
    }

    /// Explorer started again with none of the icons: each is added anew.
    pub(crate) fn forget(&mut self) {
        for (_, icon) in self.icons.drain(..) {
            unsafe { DestroyIcon(icon) };
        }
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        for id in self.icons.iter().map(|(id, _)| *id).collect::<Vec<_>>() {
            self.remove(id);
        }
        unsafe { DestroyWindow(self.window) };
    }
}

/// The side of a notification icon in pixels, and the scale it is drawn
/// at: the small icon of the system DPI, which the notification area uses.
pub(crate) fn icon_side() -> (u32, f32) {
    let dpi = unsafe { GetDpiForSystem() }.max(96);
    let side = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) }.max(16) as u32;
    (side, dpi as f32 / 96.)
}

/// Whether the taskbar is dark now (`super::taskbar_dark`).
pub(crate) fn taskbar_dark() -> bool {
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("SystemUsesLightTheme");
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    super::taskbar_dark((status == 0).then_some(value))
}

/// A 32-bit top-down DIB section of `side` square, and its pixels.
fn section(side: u32) -> Option<(HBITMAP, *mut u8)> {
    let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: side as i32,
        biHeight: -(side as i32),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..unsafe { std::mem::zeroed() }
    };
    let mut bits = std::ptr::null_mut();
    let bitmap = unsafe {
        CreateDIBSection(
            std::ptr::null_mut(),
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        )
    };
    (!bitmap.is_null() && !bits.is_null()).then_some((bitmap, bits.cast()))
}

/// An icon of `side` square from straight-alpha BGRA pixels
/// (`super::icon_bgra`); its mask is empty, since the colour bitmap's alpha
/// says what shows.
pub(crate) fn icon(bgra: &[u8], side: u32) -> Option<HICON> {
    let (color, bits) = section(side)?;
    let len = (side * side * 4) as usize;
    unsafe {
        std::ptr::copy_nonoverlapping(bgra.as_ptr(), bits, len.min(bgra.len()));
        let zeros = vec![0u8; (side.div_ceil(16) * 2 * side) as usize];
        let mask = CreateBitmap(side as i32, side as i32, 1, 1, zeros.as_ptr().cast());
        let info = ICONINFO {
            fIcon: 1,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&info);
        DeleteObject(mask);
        DeleteObject(color);
        (!icon.is_null()).then_some(icon)
    }
}

/// The app's own icon (the executable's icon resource 1, `crate::icon`) at
/// `side` square, as premultiplied RGBA, or `None` when it has none.
pub(crate) fn app_icon(side: u32) -> Option<Vec<u8>> {
    let own = unsafe {
        LoadImageW(
            GetModuleHandleW(std::ptr::null()),
            1 as _,
            IMAGE_ICON,
            side as i32,
            side as i32,
            LR_DEFAULTCOLOR,
        )
    };
    // With no icon of its own, the system's application icon, as a window's.
    let icon = match own.is_null() {
        true => unsafe { LoadIconW(std::ptr::null_mut(), IDI_APPLICATION) },
        false => own,
    };
    if icon.is_null() {
        return None;
    }
    let (bitmap, bits) = section(side)?;
    let len = (side * side * 4) as usize;
    let drawn = unsafe {
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        let old = SelectObject(dc, bitmap);
        let drawn = DrawIconEx(
            dc,
            0,
            0,
            icon,
            side as i32,
            side as i32,
            0,
            std::ptr::null_mut(),
            DI_NORMAL,
        ) != 0;
        GdiFlush();
        SelectObject(dc, old);
        DeleteDC(dc);
        // The system's icon is shared, and never destroyed.
        if !own.is_null() {
            DestroyIcon(own);
        }
        drawn
    };
    let pixels = drawn.then(|| {
        let bgra = unsafe { std::slice::from_raw_parts(bits, len) };
        bgra.as_chunks::<4>()
            .0
            .iter()
            .flat_map(|px| [px[2], px[1], px[0], px[3]])
            .collect()
    });
    unsafe { DeleteObject(bitmap) };
    pixels
}

unsafe extern "system" fn receive(
    window: HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    subclass: usize,
    data: usize,
) -> isize {
    unsafe {
        let state = &*(data as *const State);
        let heard = match message {
            CALLBACK => Some(Heard::Callback(super::callback(wparam, lparam))),
            m if m == state.taskbar_created && m != 0 => Some(Heard::TaskbarCreated),
            WM_SETTINGCHANGE if lparam != 0 => {
                let name: Vec<u16> = (0..)
                    .map(|i| *(lparam as *const u16).add(i))
                    .take_while(|c| *c != 0)
                    .collect();
                (name == "ImmersiveColorSet".encode_utf16().collect::<Vec<_>>())
                    .then_some(Heard::Theme)
            }
            WM_NCDESTROY => {
                RemoveWindowSubclass(window, Some(receive), subclass);
                drop(Rc::from_raw(data as *const State));
                None
            }
            _ => None,
        };
        if let Some(heard) = heard {
            state.heard.borrow_mut().push(heard);
            if let Some(wake) = &*state.wake.borrow() {
                wake();
            }
            if message == CALLBACK {
                return 0;
            }
        }
        DefSubclassProc(window, message, wparam, lparam)
    }
}
