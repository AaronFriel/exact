//! The plan's child sites, in the order the runner mounts them.
use exact_plan::Plan;

#[derive(Clone, Copy, Debug)]
pub enum Site {
    Node(u32),
    Region(u32),
}

/// The plan's child sites, grouped as the runner groups them.
pub struct Sites {
    pub root: u32,
    by_node: Vec<Vec<Site>>,
    by_arm: Vec<Vec<Site>>,
}

impl Sites {
    pub fn new(plan: &Plan) -> Result<Sites, String> {
        let mut by_node: Vec<Vec<(u32, u8, u32, Site)>> = vec![Vec::new(); plan.nodes.len()];
        let mut by_arm: Vec<Vec<(u32, u8, u32, Site)>> = vec![Vec::new(); plan.arms.len()];
        let mut root = None;
        for (i, n) in plan.nodes.iter().enumerate() {
            let e = (n.order, 0, i as u32, Site::Node(i as u32));
            // A site's group is (parent, arm): an arm's roots have no parent;
            // a deeper site names its parent node and its enclosing arm.
            match (n.parent, n.arm) {
                (Some(p), _) => by_node[p.0 as usize].push(e),
                (None, Some(a)) => by_arm[a.0 as usize].push(e),
                (None, None) => {
                    if root.replace(i as u32).is_some() {
                        return Err("more than one root".into());
                    }
                }
            }
        }
        for (i, r) in plan.regions.iter().enumerate() {
            let e = (r.order, 1, i as u32, Site::Region(i as u32));
            match (r.parent, r.arm) {
                (Some(p), _) => by_node[p.0 as usize].push(e),
                (None, Some(a)) => by_arm[a.0 as usize].push(e),
                (None, None) => return Err("a region at the root".into()),
            }
        }
        let sort = |v: Vec<Vec<(u32, u8, u32, Site)>>| {
            v.into_iter()
                .map(|mut l| {
                    l.sort_by_key(|e| (e.0, e.1, e.2));
                    l.into_iter().map(|e| e.3).collect()
                })
                .collect()
        };
        Ok(Sites {
            root: root.ok_or("no root")?,
            by_node: sort(by_node),
            by_arm: sort(by_arm),
        })
    }
    pub fn of_node(&self, n: u32) -> &[Site] {
        &self.by_node[n as usize]
    }
    pub fn of_arm(&self, a: u32) -> &[Site] {
        &self.by_arm[a as usize]
    }
}

/// Mark each arm a resource or task owner crosses when it mounts. A site
/// with a parent mounts under that node, even in a hand-built plan.
pub(super) fn instance_paths(plan: &Plan) -> Vec<bool> {
    let mut paths = vec![false; plan.arms.len()];
    let mut nodes = std::collections::HashSet::new();
    let owners = plan
        .resources
        .iter()
        .filter_map(|r| r.owner)
        .chain(plan.timers.iter().filter_map(|t| t.owner));
    for owner in owners {
        let mut arm = Some(owner);
        while let Some(id) = arm {
            if std::mem::replace(&mut paths[id.0 as usize], true) {
                break;
            }
            let region = plan.region(plan.arm(id).region);
            let mut parent = region.parent;
            arm = region.arm;
            while let Some(id) = parent {
                if !nodes.insert(id) {
                    arm = None;
                    break;
                }
                let node = plan.node(id);
                (parent, arm) = (node.parent, node.arm);
            }
        }
    }
    paths
}
