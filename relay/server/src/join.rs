//! The page behind an invite link people can click: `https://<host>/join#invite=<token>`.
//!
//! An invite is a secret, and a link in a chat or a mail has to be an ordinary web address to be
//! clickable at all. So the token rides in the part after `#`, which a browser keeps to itself:
//! this page is the same for everyone, the relay never sees which invite was opened, and nothing
//! of it reaches a log. The page's own script reads the token and hands it to the Cube app.

/// What goes out with the page: nothing may be loaded from anywhere, nothing is kept, and the
/// address is not passed on to wherever the visitor goes next.
pub const HEADERS: [(&str, &str); 5] = [
    ("content-type", "text/html; charset=utf-8"),
    (
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ),
    ("referrer-policy", "no-referrer"),
    ("cache-control", "no-store"),
    ("x-content-type-options", "nosniff"),
];

fn escaped(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&#39;".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// The page for a workspace called `name`. `app_url` is where the Cube app can be had, if the
/// person running the relay said so.
pub fn page(name: &str, app_url: Option<&str>) -> String {
    let name = escaped(name);
    let get = match app_url {
        Some(url) => format!(
            r#"<p class="quiet"><span data-ko="아직 Cube가 없나요?">No Cube yet?</span> <a href="{0}" rel="noreferrer noopener" data-ko="여기서 받으세요">Get it here</a>, <span data-ko="설치한 뒤 이 페이지로 돌아와 다시 누르세요.">then come back to this page and press the button again.</span></p>"#,
            escaped(url)
        ),
        None => r#"<p class="quiet" data-ko="아직 Cube가 없다면, 초대한 사람에게 설치 방법을 물어보세요. 설치한 뒤 이 페이지로 돌아와 다시 누르면 됩니다.">No Cube yet? Ask whoever invited you how to get it, then come back to this page and press the button again.</p>"#.to_string(),
    };
    format!(
        r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Join {name} on Cube</title>
<style>
  :root {{ color-scheme: light dark; --bg: #f5f5f7; --card: #fff; --ink: #1d1d1f; --quiet: #6e6e73; --line: #d2d2d7; --accent: #0071e3; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg: #000; --card: #1c1c1e; --ink: #f5f5f7; --quiet: #98989d; --line: #38383a; --accent: #2997ff; }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", sans-serif; }}
  main {{ width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 22px; padding: 28px; }}
  h1 {{ margin: 0 0 6px; font-size: 24px; line-height: 1.2; letter-spacing: -0.02em; }}
  p {{ margin: 0 0 16px; }}
  .quiet {{ color: var(--quiet); font-size: 14px; }}
  a.go {{ display: block; text-align: center; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; border-radius: 999px; padding: 11px 16px; margin: 0 0 16px; }}
  a.go:focus-visible, button:focus-visible {{ outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }}
  code {{ display: block; overflow-wrap: anywhere; background: var(--bg); border-radius: 10px; padding: 10px 12px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0 0 8px; }}
  button {{ font: inherit; font-size: 14px; font-weight: 600; border: 0; border-radius: 999px; padding: 7px 14px; background: var(--bg); color: var(--ink); cursor: pointer; }}
  [hidden] {{ display: none !important; }}
</style>
</head>
<body>
<main>
  <h1><span data-ko="{name} 팀에 참여">Join {name}</span></h1>
  <div id="ok" hidden>
    <p data-ko="Cube에서 이 초대를 엽니다. 아래 버튼을 누르면 Cube가 열리고, 이름을 확인한 뒤 바로 팀에 들어갑니다.">This invite opens in Cube. Press the button and Cube comes up, asks for your name, and you are in.</p>
    <a class="go" id="go" href="#" data-ko="Cube에서 열기">Open in Cube</a>
    {get}
    <p class="quiet" data-ko="버튼이 듣지 않으면 아래 링크를 복사해 Cube의 설정 &gt; 사람 &gt; 팀 참여에 붙여 넣으세요.">If the button does nothing, copy the link below and paste it in Cube under Settings &gt; People &gt; Join a team.</p>
    <code id="link"></code>
    <button type="button" id="copy" data-ko="링크 복사">Copy link</button>
    <p class="quiet" style="margin-top:16px" data-ko="이 링크는 입장권입니다. 다른 사람에게 넘기지 마세요.">This link is a ticket in. Do not pass it on.</p>
  </div>
  <div id="bad" hidden>
    <p data-ko="이 주소에는 초대가 들어 있지 않습니다. 받은 링크 전체를 다시 열어 보세요.">There is no invite in this address. Open the whole link you were sent.</p>
  </div>
</main>
<script>
(function () {{
  var ko = (navigator.language || "").toLowerCase().indexOf("ko") === 0;
  if (ko) {{
    document.documentElement.lang = "ko";
    var all = document.querySelectorAll("[data-ko]");
    for (var i = 0; i < all.length; i++) all[i].textContent = all[i].getAttribute("data-ko");
    document.title = document.querySelector("h1").textContent;
  }}
  var m = /^#invite=([A-Za-z0-9_-]{{20,200}})$/.exec(location.hash);
  if (!m) {{ document.getElementById("bad").hidden = false; return; }}
  var host = location.host;
  var local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  var paste = "cube+" + (local ? "ws" : "wss") + "://" + host + "/#invite=" + m[1];
  document.getElementById("go").href = "cube://" + host + "/#invite=" + m[1];
  document.getElementById("link").textContent = paste;
  document.getElementById("copy").addEventListener("click", function () {{
    var b = this;
    navigator.clipboard.writeText(paste).then(function () {{ b.textContent = ko ? "복사됨" : "Copied"; }});
  }});
  document.getElementById("ok").hidden = false;
}})();
</script>
</body>
</html>
"##
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_names_the_workspace_and_cannot_be_written_into() {
        let html = page("Design <b>team</b> & \"friends\"", None);
        assert!(html.contains("Join Design &lt;b&gt;team&lt;/b&gt; &amp; &quot;friends&quot;"));
        assert!(!html.contains("<b>team</b>"));
    }

    #[test]
    fn says_where_to_get_the_app_only_when_told() {
        assert!(!page("Team", None).contains("Get it here"));
        let html = page("Team", Some("https://example.com/cube?a=1&b=\"2\""));
        assert!(html.contains(r#"href="https://example.com/cube?a=1&amp;b=&quot;2&quot;""#));
    }

    #[test]
    fn the_token_is_only_ever_read_from_the_fragment_by_the_page_itself() {
        let html = page("Team", None);
        assert!(html.contains("location.hash"));
        // Nothing on the page posts, fetches or loads anything.
        for word in ["fetch(", "XMLHttpRequest", "<form", "<img", "<link", "src="] {
            assert!(!html.contains(word), "{word}");
        }
    }
}
