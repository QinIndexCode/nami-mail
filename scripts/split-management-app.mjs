// One-time script: wire management dialogs (contacts/templates/accounts) into
// App.tsx and strip account management out of the settings modal render.
import fs from "node:fs";

const file = "apps/web/src/App.tsx";
let s = fs.readFileSync(file, "utf8");

function eolAfter(index) {
  const end = s.indexOf("\n", index);
  if (end === -1) return "\n";
  return s[end - 1] === "\r" ? "\r\n" : "\n";
}

function replaceOnce(anchor, lines) {
  const i = s.indexOf(anchor);
  if (i === -1) throw new Error("anchor not found: " + anchor.slice(0, 80));
  const eol = eolAfter(i);
  s = s.slice(0, i) + lines.join(eol) + s.slice(i + anchor.length);
}

function insertBefore(anchor, lines) {
  const i = s.indexOf(anchor);
  if (i === -1) throw new Error("insert-before anchor not found: " + anchor.slice(0, 80));
  const eol = eolAfter(i);
  s = s.slice(0, i) + lines.join(eol) + eol + s.slice(i);
}

// 1. Lucide icons for the new sidebar entries.
replaceOnce("  ArrowLeft,", ["  ArrowLeft,", "  AtSign,"]);
replaceOnce("  Sun,", ["  Sun,", "  Users,"]);

// 2. Import the management dialogs next to the settings modal import.
replaceOnce('import SettingsModal from "./SettingsModal";', [
  'import SettingsModal from "./SettingsModal";',
  'import { AccountsDialog, ContactsDialog, TemplatesDialog } from "./ManagementDialogs";',
]);

// 3. Replace the settings scroll state with the three dialog open states.
replaceOnce("  const [settingsScrollToAccounts, setSettingsScrollToAccounts] = useState(false);", [
  "  const [contactsOpen, setContactsOpen] = useState(false);",
  "  const [templatesOpen, setTemplatesOpen] = useState(false);",
  "  const [accountsOpen, setAccountsOpen] = useState(false);",
]);

// 4. Escape chain closes the management dialogs too.
replaceOnce("        if (settingsOpen) setSettingsOpen(false);", [
  "        if (settingsOpen) setSettingsOpen(false);",
  "        else if (contactsOpen) setContactsOpen(false);",
  "        else if (templatesOpen) setTemplatesOpen(false);",
  "        else if (accountsOpen) setAccountsOpen(false);",
]);

// 5. Keyboard shortcuts must not leak while a management dialog is open.
replaceOnce(
  "      if (settingsOpen || sendingStatusOpen || composeOpen || addOpen || mobileSidebar) return;",
  ["      if (settingsOpen || contactsOpen || templatesOpen || accountsOpen || sendingStatusOpen || composeOpen || addOpen || mobileSidebar) return;"],
);

// 6. Keydown effect dependencies.
replaceOnce("sendingStatusOpen, settingsOpen, updatePromptOpen]);", [
  "contactsOpen, templatesOpen, accountsOpen, sendingStatusOpen, settingsOpen, updatePromptOpen]);",
]);

// 7. Account-health banner opens the accounts dialog instead of scrolling settings.
replaceOnce(
  '<button type="button" onClick={() => { setSettingsScrollToAccounts(true); setSettingsOpen(true); }}>{t("mail.viewReason")}</button>',
  ['<button type="button" onClick={() => setAccountsOpen(true)}>{t("mail.viewReason")}</button>'],
);

// 8. Sidebar: management entries above the footer.
insertBefore('          <div className="sidebar-footer">', [
  '          <nav className="nav-section management-nav" aria-label={t("navigation.management")}>',
  '            <button type="button" onClick={() => { setMobileSidebar(false); setContactsOpen(true); }}><Users size={18} /><span>{t("settings.contacts.title")}</span></button>',
  '            <button type="button" onClick={() => { setMobileSidebar(false); setTemplatesOpen(true); }}><FileText size={18} /><span>{t("settings.templates.title")}</span></button>',
  '            <button type="button" onClick={() => { setMobileSidebar(false); setAccountsOpen(true); }}><AtSign size={18} /><span>{t("settings.account.title")}</span></button>',
  "          </nav>",
]);

// 9. Settings modal: drop account props; render the three management dialogs.
replaceOnce(
  '{settingsOpen && <SettingsModal settings={settings} accounts={accounts} onClose={() => { setSettingsOpen(false); setSettingsScrollToAccounts(false); }} onSettingsChange={applySettings} onAccountRemoved={removeAccountFromView} onAccountSignatureChanged={updateAccountSignatureInState} onAccountSync={retryAccountSync} onTestNotification={testDesktopNotification} onTestSound={testNotificationSound} onTranslationConfigurationChanged={refreshTranslationAvailability} onOpenAgentProviderSettings={() => { setSettingsOpen(false); setSettingsScrollToAccounts(false); setAgentProviderSettingsRequestId((requestId) => requestId + 1); setAgentOpen(true); }} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} scrollToAccounts={settingsScrollToAccounts} />}',
  [
    '{settingsOpen && <SettingsModal settings={settings} accounts={accounts} onClose={() => setSettingsOpen(false)} onSettingsChange={applySettings} onTestNotification={testDesktopNotification} onTestSound={testNotificationSound} onTranslationConfigurationChanged={refreshTranslationAvailability} onOpenAgentProviderSettings={() => { setSettingsOpen(false); setAgentProviderSettingsRequestId((requestId) => requestId + 1); setAgentOpen(true); }} fallbackFocusRef={mobileMenuButtonRef} demoMode={isDemo} />}',
    '{contactsOpen && <ContactsDialog demoMode={isDemo} onClose={() => setContactsOpen(false)} fallbackFocusRef={mobileMenuButtonRef} />}',
    '{templatesOpen && <TemplatesDialog demoMode={isDemo} onClose={() => setTemplatesOpen(false)} fallbackFocusRef={mobileMenuButtonRef} />}',
    '{accountsOpen && <AccountsDialog accounts={accounts} demoMode={isDemo} onClose={() => setAccountsOpen(false)} onAccountRemoved={removeAccountFromView} onAccountSignatureChanged={updateAccountSignatureInState} onAccountSync={retryAccountSync} fallbackFocusRef={mobileMenuButtonRef} />}',
  ],
);

// 10. Defer the update prompt while any management dialog is open.
replaceOnce(
  "defer={addOpen || composeOpen || settingsOpen || sendingStatusOpen || mobileSidebar || syncing}",
  ["defer={addOpen || composeOpen || settingsOpen || contactsOpen || templatesOpen || accountsOpen || sendingStatusOpen || mobileSidebar || syncing}"],
);

fs.writeFileSync(file, s);
console.log("App.tsx updated.");
