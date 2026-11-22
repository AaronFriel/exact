//! A process launch prepares hardware during boot. A resident window presents
//! through WARP before reopening hardware. @ref LLP 1149 D6.3, S2.9.
use super::*;
use std::sync::{mpsc, Arc};

// NucBox S2.8b: a driver-cache-cold screen displayed at 251–255 ms;
// the 100 ms bound opened WARP in three of ten retained-store launches.
const STARTUP_DEVICE_BUDGET: Duration = Duration::from_millis(300);

type Arrival = (bool, Option<Result<Prepared>>);

#[derive(Clone, Copy, PartialEq)]
enum Order {
    HardwareFirst,
    WarpFirst,
    WarpOnly,
}

enum SecondDevice {
    Open,
    Cancel,
}

pub struct Startup {
    receive: mpsc::Receiver<Arrival>,
    workers: Vec<std::thread::JoinHandle<()>>,
    pending: [bool; 2],
    order: Order,
    after_present: Option<mpsc::Sender<SecondDevice>>,
    deadline: Instant,
}

impl Startup {
    pub fn start(force_warp: bool) -> Result<Self> {
        let now = Instant::now();
        let age = Duration::from_secs_f64(super::super::process_ms()? / 1000.);
        let deadline = now + STARTUP_DEVICE_BUDGET.saturating_sub(age);
        let order = if force_warp {
            Order::WarpOnly
        } else {
            Order::HardwareFirst
        };
        Self::start_with(order, deadline, Prepared::open)
    }

    /// A show request has no process boot to overlap with device creation.
    /// Starting hardware before WARP presents can delay both in DXGI.
    pub fn start_for_first_present(force_warp: bool) -> Result<Self> {
        let now = Instant::now();
        let order = if force_warp {
            Order::WarpOnly
        } else {
            Order::WarpFirst
        };
        Self::start_with(order, now + STARTUP_DEVICE_BUDGET, Prepared::open)
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    fn start_with(
        order: Order,
        deadline: Instant,
        open: impl Fn(bool) -> Result<Prepared> + Send + Sync + 'static,
    ) -> Result<Self> {
        let (send, receive) = mpsc::channel();
        let (schedule, wait) = mpsc::channel();
        let open = Arc::new(move |warp| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| open(warp)))
                .unwrap_or_else(|_| Err(Error::Device("device worker panicked".into())))
        });
        let mut workers = Vec::new();
        let primary = open.clone();
        let arrived = send.clone();
        let first_warp = order != Order::HardwareFirst;
        let after_present = (order == Order::WarpFirst).then(|| schedule.clone());
        workers.push(
            std::thread::Builder::new()
                .name("ink-device".into())
                .spawn(move || {
                    let result = primary(first_warp);
                    let success = result.is_ok();
                    let _ = arrived.send((first_warp, Some(result)));
                    if !success {
                        let _ = schedule.send(SecondDevice::Open);
                    } else if order == Order::HardwareFirst {
                        let _ = schedule.send(SecondDevice::Cancel);
                    }
                })
                .map_err(|e| Error::Device(e.to_string()))?,
        );
        if order != Order::WarpOnly {
            workers.push(
                std::thread::Builder::new()
                    .name("ink-second-device".into())
                    .spawn(move || {
                        let start =
                            wait.recv_timeout(deadline.saturating_duration_since(Instant::now()));
                        let result = match start {
                            Ok(SecondDevice::Open) | Err(mpsc::RecvTimeoutError::Timeout) => {
                                Some(open(!first_warp))
                            }
                            _ => None,
                        };
                        let _ = send.send((!first_warp, result));
                    })
                    .map_err(|e| Error::Device(e.to_string()))?,
            );
        }
        Ok(Self {
            receive,
            workers,
            pending: [order != Order::WarpOnly, true],
            order,
            after_present,
            deadline,
        })
    }

    /// The first WARP frame was submitted, or WARP refused the window.
    pub fn allow_hardware(&mut self) {
        if let Some(schedule) = self.after_present.take() {
            let _ = schedule.send(SecondDevice::Open);
        }
    }

    pub fn force_warp(&self) -> bool {
        self.order == Order::WarpOnly
    }
    pub fn pending(&self) -> bool {
        self.pending.iter().any(|p| *p)
    }
    pub fn hardware_pending(&self) -> bool {
        self.pending[0]
    }

    pub fn poll(&mut self) -> Option<(bool, Result<D3d11>)> {
        self.wait_until(Instant::now())
    }

    pub fn wait_until(&mut self, deadline: Instant) -> Option<(bool, Result<D3d11>)> {
        while self.pending() {
            match self
                .receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok((warp, result)) => {
                    self.pending[usize::from(warp)] = false;
                    if let Some(result) = result {
                        let device = result.and_then(D3d11::from_prepared);
                        if warp && device.is_err() {
                            self.allow_hardware();
                        }
                        return Some((warp, device));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => return None,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let warp = !self.pending[0];
                    self.pending[usize::from(warp)] = false;
                    return Some((
                        warp,
                        Err(Error::Device("startup worker disconnected".into())),
                    ));
                }
            }
        }
        None
    }
}

impl Drop for Startup {
    fn drop(&mut self) {
        if let Some(schedule) = self.after_present.take() {
            let _ = schedule.send(SecondDevice::Cancel);
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn both_worker_refusals_are_delivered() {
        let now = Instant::now();
        let mut startup = Startup::start_with(Order::HardwareFirst, now, |warp| {
            Err(Error::Device(if warp { "WARP" } else { "hardware" }.into()))
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut failures = Vec::new();
        while let Some((warp, result)) = startup.wait_until(deadline) {
            assert!(result.is_err());
            failures.push(warp);
        }
        failures.sort();
        assert_eq!(failures, [false, true]);
        assert!(!startup.pending());
    }

    #[test]
    fn reopening_waits_for_the_first_warp_present_and_hiding_cancels_hardware() {
        use std::sync::atomic::{AtomicBool, Ordering};
        for present in [false, true] {
            let hardware = Arc::new(AtomicBool::new(false));
            let opened = hardware.clone();
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut startup = Startup::start_with(Order::WarpFirst, deadline, move |warp| {
                if warp {
                    Prepared::open(true)
                } else {
                    opened.store(true, Ordering::Relaxed);
                    Err(Error::Device("test hardware".into()))
                }
            })
            .unwrap();
            let (warp, device) = startup.wait_until(deadline).unwrap();
            assert!(warp && device.is_ok() && startup.hardware_pending());
            assert!(!hardware.load(Ordering::Relaxed));
            if present {
                startup.allow_hardware();
            }
            drop(startup);
            assert_eq!(hardware.load(Ordering::Relaxed), present);
        }
    }

    #[test]
    fn warp_starts_at_the_deadline_without_a_waiter() {
        let (send, receive) = mpsc::channel();
        let began = Instant::now();
        let deadline = began + Duration::from_millis(75);
        let startup = Startup::start_with(Order::HardwareFirst, deadline, move |warp| {
            if warp {
                send.send(Instant::now()).unwrap();
            } else {
                std::thread::sleep(Duration::from_millis(300));
            }
            Err(Error::Device("refused".into()))
        })
        .unwrap();
        let at = receive.recv_timeout(Duration::from_millis(250)).unwrap();
        assert!(at >= began + Duration::from_millis(75));
        drop(startup);
    }

    #[test]
    fn hardware_at_eighty_ms_wins_while_warp_is_pending() {
        let prepared = Mutex::new(Some(Prepared::open(true).unwrap()));
        let (release, wait) = mpsc::channel::<()>();
        let wait = Mutex::new(wait);
        let began = Instant::now();
        let deadline = began + Duration::from_millis(75);
        let mut startup = Startup::start_with(Order::HardwareFirst, deadline, move |warp| {
            if warp {
                let _ = wait.lock().unwrap().recv_timeout(Duration::from_secs(2));
                Err(Error::Device("unused WARP".into()))
            } else {
                std::thread::sleep(Duration::from_millis(80));
                Ok(prepared.lock().unwrap().take().unwrap())
            }
        })
        .unwrap();
        let arrived = startup.wait_until(began + Duration::from_millis(100));
        drop(release);
        let (warp, result) = arrived.expect("hardware must wake the bound's wait");
        assert!(!warp);
        assert!(result.is_ok());
        assert!(startup.pending());
        assert!(
            !startup.hardware_pending(),
            "late WARP must not gate hardware recovery"
        );
    }
}
