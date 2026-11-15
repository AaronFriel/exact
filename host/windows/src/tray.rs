//! The notification area (LLP 1133.025 D4): each `-exact-menu="status"`
//! button is an icon there, by `Shell_NotifyIconW` under
//! `NOTIFYICON_VERSION_4`, and its `popovertarget` menu is the shared
//! presenter's MenuFlyout in a popup window of its own at the pointer
//! (`tray/flyout.rs`, LLP 1115.004 D10.1), so it opens with the app's window
//! hidden.
//!
//! - **The icon** is the button's image (`Presenter::status_icon`), drawn at
//!   the system's small-icon size for the system DPI, as `LoadIconMetric`'s
//!   `LIM_SMALL` sizes a notification icon; a button with none, or one this
//!   host cannot draw yet, shows the app's own icon (D7). A `disabled`
//!   button's icon is dimmed to WinUI's disabled text opacity. The tooltip
//!   is its label (`szTip`).
//! - **The clicks**: the shell sends `NIN_SELECT` for a click and
//!   `NIN_KEYSELECT` for a keyboard selection, which run the button's
//!   `press`, or open its menu when it has none; `WM_CONTEXTMENU` (the right
//!   button, Shift+F10, the Menu key) opens the menu and never presses
//!   ([Shell_NotifyIconW](https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-shell_notifyiconw)).
//! - **Explorer restarting** broadcasts `TaskbarCreated` to every top-level
//!   window, and each icon is added again
//!   ([Taskbar Creation Notification](https://learn.microsoft.com/windows/win32/shell/taskbar#taskbar-creation-notification)).
//!   The icons' window is therefore a hidden top-level window, not a
//!   message-only one, which broadcasts do not reach.
//! - **An icon's identity** is its window and a 16-bit id (the callback
//!   carries the id in `lParam`'s high word), hashed from the button's
//!   `id`, else its `testId`, so that the person's choice to show or hide it
//!   in the taskbar follows it across launches, as the Mac's `autosaveName`
//!   keeps a status item's place. No GUID is given: the shell binds one to
//!   the executable's path, and a development build moves.

/// `Shell_NotifyIconW`'s callback message: `WM_APP + 1`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const CALLBACK: u32 = 0x8000 + 1;
/// `NIN_SELECT` (`WM_USER`), and `NIN_KEYSELECT` (`NIN_SELECT | NINF_KEY`).
const NIN_SELECT: u16 = 0x400;
const NIN_KEYSELECT: u16 = 0x401;
const WM_CONTEXTMENU: u16 = 0x7B;

/// What a notification icon's callback says.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum Event {
    /// A click (`keyboard` false) or a keyboard selection.
    Select { keyboard: bool },
    /// The icon's context menu was asked for.
    Menu,
    /// Anything else (a hover, a double click, a balloon).
    Other,
}

/// A callback, decoded: under version 4 `lParam`'s low word is the event
/// and its high word the icon's id, and `wParam` holds the anchor's screen
/// coordinates, as `GET_X_LPARAM` and `GET_Y_LPARAM` read them.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct Callback {
    pub event: Event,
    pub icon: u16,
    pub at: (i32, i32),
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn callback(wparam: usize, lparam: isize) -> Callback {
    let event = match lparam as usize as u16 {
        NIN_SELECT => Event::Select { keyboard: false },
        NIN_KEYSELECT => Event::Select { keyboard: true },
        WM_CONTEXTMENU => Event::Menu,
        _ => Event::Other,
    };
    Callback {
        event,
        icon: (lparam as usize >> 16) as u16,
        at: (
            wparam as u16 as i16 as i32,
            (wparam >> 16) as u16 as i16 as i32,
        ),
    }
}

/// What a click does to an item (D4's Windows clicks).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum Does {
    Press,
    Menu { keyboard: bool },
    Nothing,
}

/// `event` on an item with or without a `press` and a menu: a selection
/// presses, or opens the menu when there is no `press`; the context menu
/// opens the menu and never presses; a disabled item does neither.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn does(event: Event, press: bool, menu: bool, disabled: bool) -> Does {
    match event {
        _ if disabled => Does::Nothing,
        Event::Select { .. } if press => Does::Press,
        Event::Select { keyboard } if menu => Does::Menu { keyboard },
        Event::Menu if menu => Does::Menu { keyboard: false },
        _ => Does::Nothing,
    }
}

/// The icon's id for an item named `name`, distinct from the ids `taken`:
/// FNV-1a folded to 16 bits, then the next free one; never 0.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn id(name: &str, taken: &[u16]) -> u16 {
    let hash = name.bytes().fold(0x811c_9dc5_u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    });
    let mut id = ((hash >> 16) ^ hash) as u16;
    while id == 0 || taken.contains(&id) {
        id = id.wrapping_add(1);
    }
    id
}

/// `szTip`: the label in at most 127 UTF-16 units and a NUL, never ending
/// on half a surrogate pair.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn tip(label: &str) -> [u16; 128] {
    let mut out = [0u16; 128];
    let mut at = 0;
    for c in label.chars() {
        let mut units = [0u16; 2];
        let units = c.encode_utf16(&mut units);
        if at + units.len() > 127 {
            break;
        }
        out[at..at + units.len()].copy_from_slice(units);
        at += units.len();
    }
    out
}

/// WinUI's disabled text opacity (`TextFillColorDisabled`, `#5C` of 255),
/// which a disabled item's icon takes.
const DIMMED: u32 = 0x5C;

/// An icon's colour bitmap from premultiplied RGBA pixels: BGRA with
/// straight alpha, as a 32-bit icon image holds it, dimmed for a disabled
/// item.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn icon_bgra(rgba: &[u8], dimmed: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len());
    for px in rgba.as_chunks::<4>().0 {
        let a = u32::from(px[3]);
        let straight = |c: u8| match a {
            0 => 0,
            _ => ((u32::from(c) * 255 + a / 2) / a).min(255) as u8,
        };
        let alpha = if dimmed { (a * DIMMED + 127) / 255 } else { a };
        out.extend([
            straight(px[2]),
            straight(px[1]),
            straight(px[0]),
            alpha as u8,
        ]);
    }
    out
}

/// Whether the taskbar is dark, from `SystemUsesLightTheme` under
/// `HKCU\…\Themes\Personalize` (the system mode the taskbar follows, apart
/// from the apps' mode): 1 is light; 0, or a Windows that keeps no value
/// (before version 1903, whose taskbar was always dark), is dark.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn taskbar_dark(system_uses_light: Option<u32>) -> bool {
    system_uses_light != Some(1)
}

/// What the shell must be told to show `wanted` where it shows `placed`:
/// each `(id, picture)`, in order, where a picture is whatever tells two
/// icons apart (the tooltip and the pixels).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum Op {
    Add(u16),
    Modify(u16),
    Delete(u16),
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn ops<T: PartialEq>(placed: &[(u16, T)], wanted: &[(u16, T)]) -> Vec<Op> {
    let gone = placed
        .iter()
        .filter(|(id, _)| !wanted.iter().any(|(w, _)| w == id))
        .map(|(id, _)| Op::Delete(*id));
    let changed =
        wanted
            .iter()
            .filter_map(|(id, picture)| match placed.iter().find(|(p, _)| p == id) {
                None => Some(Op::Add(*id)),
                Some((_, was)) if was != picture => Some(Op::Modify(*id)),
                Some(_) => None,
            });
    gone.chain(changed).collect()
}

/// A key in the menu's window, by `KeyboardEvent.key`'s name: the keys a
/// menu takes, and a letter or digit for its type-ahead.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn key(vk: u32) -> Option<String> {
    Some(
        match vk {
            0x0D => "Enter",
            0x1B => "Escape",
            0x20 => " ",
            0x09 => "Tab",
            0x21 => "PageUp",
            0x22 => "PageDown",
            0x23 => "End",
            0x24 => "Home",
            0x25 => "ArrowLeft",
            0x26 => "ArrowUp",
            0x27 => "ArrowRight",
            0x28 => "ArrowDown",
            0x30..=0x39 | 0x41..=0x5A => {
                return char::from_u32(vk).map(|c| c.to_ascii_lowercase().to_string())
            }
            _ => return None,
        }
        .to_owned(),
    )
}

/// A wheel notch's `delta` (`WHEEL_DELTA` is 120) in points down the menu,
/// at the person's lines per notch and WinUI's 16-point line.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn wheel(delta: i16, lines: u32) -> f32 {
    -f32::from(delta) / 120. * lines as f32 * 16.
}

#[cfg(windows)]
mod flyout;
#[cfg(windows)]
pub(crate) mod shell;
#[cfg(windows)]
pub(crate) use flyout::{Flyout, Input};
#[cfg(windows)]
pub(crate) use shell::{Heard, Shell};

#[cfg(test)]
mod tests;
