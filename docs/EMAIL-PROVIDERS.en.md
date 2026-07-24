# Email Provider Setup

[简体中文](EMAIL-PROVIDERS.md) | [English](EMAIL-PROVIDERS.en.md)

Nami Mail synchronizes with IMAP and sends with SMTP. It prefers built-in provider presets and attempts DNS auto-discovery for custom domains. Discovery is only a starting point; it does not replace the final configuration supplied by an enterprise administrator or mail provider.

## Before You Start

1. In your provider's Web settings, confirm that IMAP/SMTP is enabled. The provider can require two-factor authentication, phone verification, or administrator approval.
2. Prepare a long-lived client credential: an app password, client authorization code, separate password, or OAuth authorization. Do not enter a one-time SMS, email, or authenticator code.
3. Enter the complete address so Nami Mail can show provider-specific guidance. For custom-domain, school, or enterprise accounts, verify the server and policy supplied by the administrator first.
4. If a connection fails, read the error in the app before troubleshooting. Repeatedly trying a normal Web password does not usually solve OAuth, authorization-code, or administrator-policy failures.

Nami Mail uses credentials only to connect directly to the provider you chose. See [privacy and local data](PRIVACY.en.md) for the local encryption boundaries of credentials, OAuth refresh tokens, and sensitive mail data.

## Common Providers

| Provider or account type | Common suffixes | Recommended authentication | Preparation |
| --- | --- | --- | --- |
| Gmail / Google Workspace | `gmail.com`, `googlemail.com`, enterprise custom domains | Google OAuth2; app password as a compatibility path | Prefer Google sign-in. For the password path, enable two-step verification and create an app password. A custom domain can require OAuth or MX discovery. |
| Outlook.com / Microsoft 365 | `outlook.com`, `hotmail.com`, `live.com`, `msn.com`, `office365.com`, organization custom domains | Microsoft OAuth2 | Use Microsoft sign-in. An organization administrator can disable IMAP; verify mail protocol and consent policy. |
| iCloud Mail | `icloud.com`, `me.com`, `mac.com` | Apple app-specific password | Enable two-factor authentication on the Apple Account, then generate an app-specific password. iCloud does not support POP. |
| QQ / QQ VIP / Foxmail | `qq.com`, `vip.qq.com`, `foxmail.com` | QQ client authorization code | Enable IMAP/SMTP in QQ Mail Web settings, complete the required security verification, then generate an authorization code. |
| NetEase | `163.com`, `126.com`, `yeah.net`, `188.com`, `vip.163.com`, `vip.126.com` | NetEase client authorization password | Enable IMAP/SMTP and generate a client authorization password. For `188.com` and VIP accounts, follow account settings if endpoints differ. |
| Yahoo / AOL | Yahoo international suffixes, `aol.com`, some `verizon.net` accounts | Third-party app password | Create an app password in account security. Yahoo Japan and legacy Verizon accounts that have not migrated can require manual configuration. |
| Fastmail / Zoho | Fastmail legacy suffixes, `zoho.com`, `zohomail.com` | App password preferred | Confirm that your plan allows third-party IMAP/SMTP. Zoho enterprise domains can use different IMAP endpoints. |
| Sina / Sohu / 139 / 189 / Aliyun | `sina.com`, `sina.cn`, `sohu.com`, `139.com`, `189.cn`, `aliyun.com` | Provider authorization code, separate password, or client password | Enable the required protocol and credential in provider settings. If a preset fails, use official endpoints in manual setup. |
| Yandex | `yandex.com`, `yandex.ru`, `ya.ru` | App password | Enable IMAP, then create an app password for the mail client. |
| Enterprise, school, or self-hosted mail | Any custom domain | Administrator-specified password, app password, or OAuth | Try discovery first. If it remains unclear, ask the administrator for IMAP, SMTP, ports, encryption, and username rules. |

This table lists common preset entry points. It is not proof of real-account compatibility for every provider, country site, plan, or enterprise tenant. Providers can change protocol and authentication policies at any time. Official help links shown by the app and administrator guidance take precedence over old screenshots or third-party tutorials.

## Google and Microsoft OAuth

Nami Mail currently implements OAuth sign-in only for Google and Microsoft. OAuth uses a public client and a local loopback callback. It neither needs nor accepts a client secret.

- **Google**: use a Google Cloud **Desktop app** client. If an organization account is restricted by an administrator, follow the organization's OAuth rules.
- **Microsoft**: use Microsoft Entra **Mobile and desktop applications / public client** configuration. If an organization account reports IMAP or permission restrictions, an administrator must enable the relevant capability.
- **A disabled button**: usually means the installed build has no matching public client ID, or discovery does not support that entry point for the account. Do not replace Microsoft OAuth with a normal password. Gmail may use the app-password compatibility path only when the provider allows it.

Developers can find callback, client ID, and tenant configuration in the [OAuth configuration section of the README](../README.en.md#oauth-configuration). Regular users must not write a client secret to `nami-mail.env`, an issue, logs, or a screenshot.

## Manual IMAP / SMTP Setup

When discovery is uncertain, a preset does not apply, or an administrator provides dedicated endpoints, open **Manual IMAP / SMTP configuration** in the app:

1. Obtain IMAP and SMTP host names, ports, encryption methods, and usernames from official provider documentation or the administrator.
2. Fill in both protocols. Some providers use different IMAP and SMTP usernames. For example, an iCloud IMAP username can be the local part before `@`.
3. Choose TLS or STARTTLS. Nami Mail does not support bypassing a connection problem with plaintext authentication.
4. Before saving, check host spelling, port, transport method, and credential type one field at a time. The `imap.<domain>` and `smtp.<domain>` values in a preset are conservative starting points for unknown domains, not a guarantee for every enterprise server.

## Troubleshooting

### Authentication Failed

Confirm that you entered an app password, authorization code, or separate password rather than a Web password or one-time code. Regenerate the credential, reconnect, and make sure IMAP/SMTP is enabled. Microsoft 365 and managed Google Workspace accounts can also be rejected by administrator policy.

### TLS, Network, or Timeout

Check your network, DNS, proxy/VPN, security software, and system time. Then verify the IMAP/SMTP host, port, and TLS/STARTTLS combination. Do not weaken authentication to plaintext merely to connect. Contact the network administrator if a corporate network blocks mail ports.

### Enterprise or School Custom Domain

An email suffix alone cannot determine whether the backend is Google Workspace, Microsoft 365, Coremail, or a self-hosted system. Let discovery finish. If the result is uncertain, use manual configuration and ask the administrator about IMAP, SMTP, OAuth, and multifactor-authentication policy.

### Filing an Issue

Provide a redacted provider type, app version, operating system, runtime, chosen authentication category, error category, and minimum reproduction steps. Do not provide real addresses, mail bodies, attachment names, OAuth callback parameters, tokens, authorization codes, or passwords. Follow the [support guide](../SUPPORT.en.md).
