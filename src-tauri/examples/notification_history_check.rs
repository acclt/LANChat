//! Opt-in OS check; inspects only the explicitly named synthetic v4 test notification.
#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use windows::{core::HSTRING, UI::Notifications::ToastNotificationManager};
    let history = ToastNotificationManager::History()?;
    let app_id = HSTRING::from("com.lanchat.app");
    let entries = history
        .GetHistoryWithId(&app_id)
        .map_err(|e| format!("GetHistoryWithId: {e}"))?;
    let mut found = Vec::new();
    for index in 0..entries.Size()? {
        let entry = entries.GetAt(index)?;
        let Ok(doc) = entry.Content() else {
            continue;
        };
        let Ok(xml) = doc.GetXml() else {
            continue;
        };
        let xml = xml.to_string();
        let phone_test = std::env::args().any(|a| a == "--phone-test");
        let android_shell_test = std::env::args().any(|a| a == "--android-shell-test");
        if xml.contains("v4 合成测试通知")
            || (phone_test && xml.contains("通知推送测试") && xml.contains("LQ Chat 测试"))
            || (android_shell_test && xml.contains("LQ QA ") && xml.contains("Shell"))
        {
            let images = doc.GetElementsByTagName(&HSTRING::from("image"))?;
            let mut local_icons = 0;
            for i in 0..images.Length()? {
                let node = images.Item(i)?;
                let source = node
                    .Attributes()?
                    .GetNamedItem(&HSTRING::from("src"))?
                    .InnerText()?
                    .to_string();
                if reqwest::Url::parse(&source)
                    .ok()
                    .and_then(|url| url.to_file_path().ok())
                    .is_some_and(|path| path.is_file())
                {
                    local_icons += 1;
                }
            }
            found.push(serde_json::json!({"tag":entry.Tag()?.to_string(),"group":entry.Group()?.to_string(),"updated":xml.contains("第二次更新"),"local_icons":local_icons,"application_name":xml.contains("图标合成测试") || xml.contains("验收示例应用") || xml.contains("LQ Chat 测试") || (android_shell_test && xml.contains("Shell")),"android_shell_fixture":xml.contains("LQ QA ") && xml.contains("Shell"),"offline_fixture":xml.contains("LQ QA OFFLINE"),"stopped_fixture":xml.contains("LQ QA STOPPED"),"columns":xml.contains("subgroup")}));
            if std::env::args().any(|a| a == "--remove-synthetic") {
                history.RemoveGroupedTagWithId(&entry.Tag()?, &entry.Group()?, &app_id)?;
            }
        }
    }
    println!("{}", serde_json::to_string(&found)?);
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
