//! The notification area (`crate::tray`, LLP 1133.025 D4) in the loop's
//! turn: what its windows heard goes to the presenter before the turn's
//! work, and after it the icons and the menu's window follow the tree.
//! A measured run places none.
use super::*;
use crate::tray::{self, Does, Flyout, Heard, Input, Op, Shell};
use exact_painted::presenter::top::StatusItem;

/// What an icon shows: its tooltip and its pixels.
type Picture = ([u16; 128], Vec<u8>);

pub(super) struct Tray {
    shell: Option<Shell>,
    flyout: Option<Flyout>,
    /// Each icon the shell shows, by id, as it was last told.
    placed: Vec<(u16, Picture)>,
    /// Each item as of the last sync, by its icon's id.
    items: Vec<(u16, StatusItem)>,
    /// The kernel epoch the icons were drawn at; `None` draws them again.
    epoch: Option<u64>,
    dark: bool,
    /// The app's icon at a side, for an item with no image it can draw.
    app_icon: Option<(u32, Option<Vec<u8>>)>,
    /// The menu's anchor (screen pixels) and scale, and the opening and
    /// revision last painted.
    anchor: ((i32, i32), f32),
    painted: Option<(u32, u32)>,
    said_image: bool,
}

impl Tray {
    fn new(name: &str, proxy: &EventLoopProxy<crate::accessibility::Event>) -> Tray {
        let shell = Shell::new(name);
        let flyout = Flyout::new();
        let wake = |proxy: EventLoopProxy<_>| {
            move || drop(proxy.send_event(crate::accessibility::Event::Wake))
        };
        if let Some(shell) = &shell {
            shell.set_wake(wake(proxy.clone()));
        }
        if let Some(flyout) = &flyout {
            flyout.set_wake(wake(proxy.clone()));
        }
        Tray {
            shell,
            flyout,
            placed: Vec::new(),
            items: Vec::new(),
            epoch: None,
            dark: tray::shell::taskbar_dark(),
            app_icon: None,
            anchor: ((0, 0), 1.),
            painted: None,
            said_image: false,
        }
    }

    /// Whether any icon is shown.
    pub(super) fn placed(&self) -> bool {
        !self.placed.is_empty()
    }

    fn app_icon(&mut self, side: u32) -> Option<Vec<u8>> {
        if self.app_icon.as_ref().is_none_or(|(s, _)| *s != side) {
            self.app_icon = Some((side, tray::shell::app_icon(side)));
        }
        self.app_icon.as_ref().and_then(|(_, icon)| icon.clone())
    }
}

impl<D: DataSource + Default + 'static> App<D> {
    /// Once the presenter is made: the icons' windows, and every status
    /// button out of the page before its first frame.
    pub(super) fn tray_start(&mut self) {
        let Some(p) = self
            .presenter
            .as_mut()
            .filter(|_| self.frame_limit.is_none())
        else {
            return;
        };
        p.place_status_items();
        self.tray = Some(Tray::new(&self.name, &self.proxy));
    }

    /// What the icons and the menu heard: a click presses its button or
    /// opens its menu, and the menu's pointer and keys reach it. Exit ends
    /// the app as the person's close of a window that does not hide would.
    pub(super) fn tray_input(&mut self, events: &ActiveEventLoop) {
        let hides = self.hides_on_close();
        let (Some(tray), Some(p)) = (&mut self.tray, &mut self.presenter) else {
            return;
        };
        let heard = tray.shell.as_ref().map(Shell::take).unwrap_or_default();
        let inputs = tray.flyout.as_ref().map(Flyout::take).unwrap_or_default();
        if heard.is_empty() && inputs.is_empty() {
            return;
        }
        p.advance(self.started.elapsed().as_secs_f64() * 1000.);
        let now = p.host().now();
        for heard in heard {
            match heard {
                Heard::TaskbarCreated => {
                    if let Some(shell) = &mut tray.shell {
                        shell.forget();
                    }
                    tray.placed.clear();
                    tray.epoch = None;
                }
                Heard::Theme => {
                    tray.dark = tray::shell::taskbar_dark();
                    tray.epoch = None;
                }
                Heard::Callback(heard) => {
                    let Some((_, item)) = tray.items.iter().find(|(id, _)| *id == heard.icon)
                    else {
                        continue;
                    };
                    match tray::does(heard.event, item.press, item.menu, item.disabled) {
                        Does::Press => p.status_press(item.node, now),
                        Does::Menu { keyboard } => {
                            let (room, scale) = Flyout::room(heard.at);
                            if p.open_status_menu(item.node, room, hides, keyboard, now) {
                                tray.anchor = (heard.at, scale);
                            }
                        }
                        Does::Nothing => {}
                    }
                }
            }
        }
        let scale = tray.anchor.1;
        for input in inputs {
            match input {
                Input::Pointer(phase, x, y) => {
                    p.status_menu_pointer(phase, x / scale, y / scale, now)
                }
                Input::Left => p.status_menu_left(),
                Input::Wheel(delta) => p.status_menu_wheel(delta),
                Input::Key(name) => p.status_menu_key(&name, now),
                Input::Dismissed => p.dismiss_status_menu(now),
            }
        }
        if p.take_status_exit() {
            self.exit_by_person(events);
        }
    }

    /// The icons and the menu's window as the tree now stands.
    pub(super) fn tray_sync(&mut self) {
        let (Some(tray), Some(p)) = (&mut self.tray, &mut self.presenter) else {
            return;
        };
        let epoch = p.host().kernel().epoch();
        if tray.epoch != Some(epoch) {
            tray.epoch = Some(epoch);
            let (side, scale) = tray::shell::icon_side();
            let mut items = Vec::new();
            let mut wanted = Vec::new();
            for item in p.status_items() {
                let taken: Vec<u16> = items.iter().map(|(id, _)| *id).collect();
                let id = tray::id(&item.name, &taken);
                let drawn = item
                    .image
                    .and_then(|image| p.status_icon(image, side, scale, tray.dark));
                let drawn = match drawn {
                    Some(Ok(pixmap)) => Some(pixmap.data().to_vec()),
                    Some(Err(error)) => {
                        p.host_mut()
                            .log(format!("status item: its image did not draw: {error}"));
                        None
                    }
                    None => {
                        if item.image.is_some() && !std::mem::replace(&mut tray.said_image, true) {
                            p.host_mut().log("status item: Windows draws a symbol or an svg as its icon, not an img's file; the app's icon shows (LLP 1133.025 D4)");
                        }
                        None
                    }
                };
                let pixels = drawn.or_else(|| tray.app_icon(side)).unwrap_or_default();
                wanted.push((
                    id,
                    (
                        tray::tip(&item.label),
                        tray::icon_bgra(&pixels, item.disabled),
                    ),
                ));
                items.push((id, item));
            }
            tray.items = items;
            let Some(shell) = &mut tray.shell else {
                return;
            };
            let mut refused = Vec::new();
            for op in tray::ops(&tray.placed, &wanted) {
                match op {
                    Op::Delete(id) => shell.remove(id),
                    Op::Add(id) | Op::Modify(id) => {
                        let (_, (tip, pixels)) = wanted.iter().find(|(w, _)| *w == id).unwrap();
                        let shown = tray::shell::icon(pixels, side)
                            .is_some_and(|icon| shell.show(id, *tip, icon));
                        if !shown {
                            p.host_mut().log(format!(
                                "status item: the notification area refused icon {id}"
                            ));
                            refused.push(id);
                        }
                    }
                }
            }
            // An icon the shell refused is tried again at the next change.
            tray.placed = (wanted.into_iter())
                .filter(|(id, _)| !refused.contains(id))
                .collect();
        }
        let Some(flyout) = &mut tray.flyout else {
            return;
        };
        let Some(menu) = p.status_menu() else {
            flyout.hide();
            tray.painted = None;
            return;
        };
        if tray.painted == Some((menu.serial, menu.revision)) {
            return;
        }
        let (at, scale) = tray.anchor;
        match p.status_menu_pixels(scale) {
            Some(Ok(pixmap)) => {
                flyout.show(
                    menu.serial,
                    at,
                    pixmap.data(),
                    (pixmap.width(), pixmap.height()),
                );
                tray.painted = Some((menu.serial, menu.revision));
            }
            Some(Err(error)) => p.host_mut().log(format!("status menu: {error}")),
            None => {}
        }
    }

    /// The status menu's Exit: `beforeunload` is asked, as for a window's
    /// close, and its question shows in the window; otherwise the app ends.
    fn exit_by_person(&mut self, events: &ActiveEventLoop) {
        let stays = self.presenter.as_mut().is_some_and(|p| {
            p.advance(self.started.elapsed().as_secs_f64() * 1000.);
            let now = p.host().now();
            !p.before_unload(now)
        });
        if stays {
            return self.bring_forward();
        }
        if let Some(p) = &mut self.presenter {
            p.end_hatches();
            p.end_packages();
        }
        events.exit();
    }
}
