import type { DatabaseHandle } from "../../src/db.js";
import { protectedMessageColumns } from "../../src/message-storage.js";
import { encryptAccountPassword } from "../../src/account-credentials.js";
import type { AccountRecord } from "../../src/types.js";

export function seedRecoveryFixture(db: DatabaseHandle, key: Buffer): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO accounts(id,email,provider,provider_name,encrypted_password,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username_mode,status,created_at)
    VALUES ('account','me@example.test','custom','Fixture','unused','localhost',993,1,'localhost',465,1,'email','connected',?)`).run(now);
  const account = db.prepare("SELECT * FROM accounts WHERE id='account'").get() as AccountRecord;
  db.prepare("UPDATE accounts SET encrypted_password=?").run(encryptAccountPassword(account, "synthetic-password", key));
  db.prepare("INSERT INTO folders(account_id,path,name,special_use,uid_validity) VALUES('account','INBOX','Inbox','\\Inbox','123')").run();
  db.prepare("INSERT INTO folders(account_id,path,name,special_use,uid_validity) VALUES('account','Archive','Archive','\\Archive','456')").run();
  const payload = { messageId: "<fixture@example.test>", subject: "Private subject", fromName: "Ada", fromAddress: "ada@example.test", to: [], cc: null, inReplyTo: null, references: null, snippet: "Hello", textBody: "Private body", htmlBody: '<img src="https://image.example.test/pixel.png">', attachments: null };
  const sealed = protectedMessageColumns(key, "message", "account", payload);
  db.prepare(`INSERT INTO messages(id,account_id,mailbox,uid,subject,from_name,from_address,sent_at,snippet,text_body,html_body,flags_json,has_attachments,size,encrypted_payload,payload_version,created_at)
    VALUES ('message','account','INBOX',1,'','','',?,'','','','[]',0,0,?,1,?)`).run(now, sealed.encryptedPayload, now);
}
