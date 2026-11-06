use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsNode {
    cli: Option<String>, version: Option<String>, backend_state: Option<String>, health: Vec<String>,
    tailnet: Option<String>, magic_dns_suffix: Option<String>, user: Option<String>,
    #[serde(rename = "self")] self_peer: Option<TsPeer>, prefs: Option<TsPrefs>, peers: Vec<TsPeer>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsPeer {
    host_name: String, dns_name: String, os: String, ips: Vec<String>, online: bool,
    routes: Vec<String>, exit_node_option: bool, exit_node: bool, tags: Vec<String>,
    relay: String, cur_addr: String, last_seen: Option<String>, key_expiry: Option<String>, owner: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TsPrefs {
    accept_routes: bool, accept_dns: bool, exit_node: String, shields_up: bool,
    ssh: bool, auto_update: bool, advertise_routes: String, advertise_exit_node: bool,
}

fn text(v: &Value, key: &str) -> String { v[key].as_str().unwrap_or_default().to_owned() }
fn optional(v: &Value, key: &str) -> Option<String> { v[key].as_str().filter(|s| !s.is_empty() && *s != "0001-01-01T00:00:00Z").map(str::to_owned) }
fn flag(v: &Value, key: &str) -> bool { v[key].as_bool().unwrap_or(false) }
fn strings(v: &Value, key: &str) -> Vec<String> {
    v[key].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}
fn peer(v: &Value, users: &Value) -> TsPeer {
    let owner = v["UserID"].as_u64().and_then(|id| optional(&users[id.to_string()], "LoginName"));
    TsPeer {
        host_name: text(v, "HostName"), dns_name: text(v, "DNSName").trim_end_matches('.').to_owned(),
        os: text(v, "OS"), ips: strings(v, "TailscaleIPs"), online: flag(v, "Online"),
        routes: strings(v, "PrimaryRoutes"), exit_node_option: flag(v, "ExitNodeOption"), exit_node: flag(v, "ExitNode"),
        tags: strings(v, "Tags"), relay: text(v, "Relay"), cur_addr: text(v, "CurAddr"),
        last_seen: optional(v, "LastSeen"), key_expiry: optional(v, "KeyExpiry"), owner,
    }
}

pub fn shape(cli: String, status: &Value, prefs: Option<&Value>) -> TsNode {
    let users = &status["User"];
    let self_peer = status.get("Self").filter(|v| v.is_object()).map(|v| peer(v, users));
    let user = self_peer.as_ref().and_then(|p| p.owner.clone());
    let mut peers: Vec<_> = status["Peer"].as_object().map(|p| p.values().map(|v| peer(v, users)).collect()).unwrap_or_default();
    peers.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.host_name.cmp(&b.host_name)));
    let prefs = prefs.filter(|p| p.is_object()).map(|p| TsPrefs {
        accept_routes: flag(p, "accept-routes"), accept_dns: flag(p, "accept-dns"), exit_node: text(p, "exit-node"),
        shields_up: flag(p, "shields-up"), ssh: flag(p, "ssh"), auto_update: flag(p, "auto-update"),
        advertise_routes: text(p, "advertise-routes"), advertise_exit_node: flag(p, "advertise-exit-node"),
    });
    TsNode { cli: Some(cli), version: optional(status, "Version"), backend_state: optional(status, "BackendState"),
        health: strings(status, "Health"), tailnet: optional(&status["CurrentTailnet"], "Name"),
        magic_dns_suffix: optional(&status["CurrentTailnet"], "MagicDNSSuffix"), user, self_peer, prefs, peers }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shapes_t0_status_and_preferences() {
        let status = json!({"Version":"1.104.1", "BackendState":"Running", "Health":null,
            "CurrentTailnet":{"Name":"example.com","MagicDNSSuffix":"example.ts.net"},
            "User":{"42":{"LoginName":"me@example.com"},"7":{"LoginName":"other@example.com"}},
            "Self":{"HostName":"mac","UserID":42,"DNSName":"mac.example.ts.net.","TailscaleIPs":["100.1.2.3"],"PrimaryRoutes":null,"Tags":null},
            "Peer":{"a":{"HostName":"zebra","Online":false,"UserID":7,"LastSeen":"0001-01-01T00:00:00Z","PrimaryRoutes":null,"Tags":null},
                    "b":{"HostName":"router","Online":true,"PrimaryRoutes":["10.0.0.0/16"],"Tags":["tag:router"],"ExitNodeOption":true},
                    "c":{"HostName":"alpha","Online":true}}});
        let prefs = json!({"accept-routes":true,"accept-dns":true,"exit-node":"","auto-update":true});
        let result = serde_json::to_value(shape("/cli".into(), &status, Some(&prefs))).unwrap();
        assert_eq!(result["user"], "me@example.com");
        assert_eq!(result["self"]["dnsName"], "mac.example.ts.net");
        assert_eq!(result["self"]["routes"], json!([]));
        assert_eq!(result["self"]["tags"], json!([]));
        assert_eq!(result["peers"][0]["hostName"], "alpha");
        assert_eq!(result["peers"][1]["routes"], json!(["10.0.0.0/16"]));
        assert_eq!(result["peers"][1]["tags"], json!(["tag:router"]));
        assert_eq!(result["peers"][2]["owner"], "other@example.com");
        assert_eq!(result["peers"][2]["lastSeen"], Value::Null);
        assert_eq!(result["prefs"]["autoUpdate"], true);
    }
}
