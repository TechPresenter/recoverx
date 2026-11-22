# RecoverX — Privacy Policy

**Last updated:** 22 November 2026

## 1. Who we are

RecoverX is made by **Appsgain Technologies Private Limited**, a company registered in India ("we", "us"). We decide why and how the personal data described in this policy is used: we are its data fiduciary under India's Digital Personal Data Protection Act, 2023, and its controller under the GDPR and the UK GDPR.

Contact for anything in this policy: **info@appsgain.in**.
Grievance Officer (Digital Personal Data Protection Act, 2023): our Grievance Officer can be reached at info@appsgain.in (please put "Grievance Officer" in the subject line).

This policy covers the RecoverX desktop application for Windows (however you obtained it, including from the Microsoft Store), our website at https://recoverx.snapkio.com, our licence activation service and our update and download service.

## 2. The short version

- **Your files stay on your computer.** RecoverX scans, previews and recovers files entirely on your computer. It never uploads file contents, file names, folder names or scan results to us or to anyone else.
- **We receive data when you activate, remove or buy a licence, when you contact us, and when the app checks for updates.** The app checks for updates by itself once after each start, unless you turn that off in Settings. At start-up it may also contact our licence server in two cases: to finish removing a licence you removed while offline, and to check whether a time-limited licence that is about to end, or has recently ended, has been renewed. Section 4 lists exactly what is sent.
- **No advertising, no tracking, no selling of data.** The app and the website contain no analytics or advertising code, and the website sets no cookies.
- **Crash reports stay on your computer** unless you choose to send one to us.

## 3. What the app does on your computer

To recover files, RecoverX reads the storage devices you choose, directly and read-only. In doing so it processes the names, folders, dates, sizes and contents of files on those devices, including deleted files. All of this happens on your computer:

- Scan results (file names, paths, sizes, dates and where the data lies on the disk), your settings, your recovery history and your licence activation are stored in a database in your Windows profile, at `%APPDATA%\RecoverX`.
- Recovered files are written only to the folder you choose.
- The app keeps diagnostic log files and crash reports in the same folder. Before a crash report is written, the path of your home folder and your Windows user name are removed from it (a user name of only one or two characters is left in place, because it cannot be told apart from ordinary text).
- The Dashboard and Devices screens show information about your computer and drives (for example processor, memory, Windows version, computer name, drive model and serial number). This is displayed to you only; it is not sent anywhere.

This data stays until you delete it. Uninstalling RecoverX interactively asks whether to remove it as well; you can also delete the folder yourself at any time. Recovered files are never removed by uninstalling.

## 4. Data we receive, and why

### 4.1 Licence activation and removal

When you activate a licence key online, the app sends to our licence server (at recoverx.snapkio.com):

| Data                                                          | Purpose                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Your licence key                                              | To check that it is valid and which edition it unlocks.                                                                        |
| A computer identifier                                         | To bind the licence to this computer and count how many computers use it.                                                      |
| The product name ("recoverx")                                 | To check the key belongs to this product.                                                                                      |
| Your IP address (seen by any internet service you connect to) | Recorded with the time of each activation, to protect the service against abuse (rate limiting, investigation of key sharing). |

**How the computer identifier is made.** The app combines the application's identifier, your computer's name and the installation identifier Windows creates when it is installed (the "MachineGuid"), passes them through a one-way cryptographic hash (SHA-256), and keeps the first 24 characters. The result identifies this Windows installation to us only. It cannot be turned back into your computer's name or Windows' identifier, and it is useless for recognising your computer anywhere else. The app shows it to you in full on the Licence screen.

Our server answers with an activation record that is digitally signed and stored on your computer. It contains the edition, the licence key, the computer identifier, the dates the activation was issued and expires, and the name the licence is registered to (if one was given when it was bought).

When you remove a licence from a computer, the app sends that activation record back to our server so that the computer's place on your licence is freed.

**Automatic licence checks.** Each time RecoverX starts, it contacts our licence server without you doing anything in two cases, and only these two:

- **Finishing a removal.** If you removed a licence while the computer could not reach our server, the app keeps that activation record and sends it at the next start-up — and at each start-up after that until our server has answered — so that the computer's place on your licence is freed. It sends the same activation record as an online removal.
- **Checking for a renewal.** If your licence is time-limited and ends within the next 14 days, or ended less than 30 days ago, the app sends your licence key, the computer identifier and the product name — the same data as an activation — once per start-up, to find out whether the licence has been renewed. If it has, the app stores the new activation record with the new end date. A licence with no end date, with more than 14 days left, or that ended more than 30 days ago is never checked this way.

The **Check for renewal** button on the Licence screen sends the same data as the renewal check whenever you click it. Our server records each of these requests, with your IP address and the time, in the same way as an activation.

Our licence server also keeps a technical log of the requests it answers — the time, the address requested, the result, your IP address, the computer identifier and, for an activation or renewal check, the edition it unlocked, with licence keys shortened so they cannot be read in full — to keep the service running and to investigate faults. Your IP address (for an IPv6 address, its first half) is also used to limit how many requests can come from one address in a short time. Section 6 says how long all of this is kept.

If you activate **offline**, nothing is sent by the app. You send us the computer identifier yourself (for example by email), and we send back an activation record.

### 4.2 Buying a licence

Licences are sold through our website (https://recoverx.snapkio.com/buy/), never inside the app or its installer. The app only opens that page in your web browser, without adding any information about you or your computer to the address.

At present you buy a licence by sending the order form on https://recoverx.snapkio.com/buy/ (or by emailing us at info@appsgain.in), and we reply with how to pay. The form sends us the edition and number of licences you want, your name, your email address and your mobile number with its country code, all of which are required, and — if you fill them in — the name the licence should be registered to, your GSTIN and a message. Our licence server stores the order request in its database, where we see it in our administration panel, and also passes it on to our mailboxes by email through Amazon Simple Email Service. It sends you a short confirmation (at most one a day to the same address) that names the edition, the number of licences and the order reference. Your IP address is used, as for every request to our server, to limit how many forms can come from one address (section 4.1) and appears in the server's request log (section 6). By email or form, we receive from you your name, your email address, the edition you want, your mobile number (the form requires it) and any billing details you give us for the invoice. From the payment itself we see what our bank shows us for it: typically the payer's name, the amount, the date, a transaction reference and, for a UPI payment, the payer's UPI ID. We record your name, email address and order reference with the licence key we issue, so that we can deliver the key, provide support, process refunds and keep the accounting records the law requires. We email the licence key to the address you gave, from licences@snapkio.com, through Amazon Simple Email Service (section 7); your replies reach info@appsgain.in.

You pay through your own bank, UPI app or payment service, which handles your card or account details under its own terms; neither we nor the app ever see them. If we add an online payment page, this policy will name the company that runs it before the page goes live.

### 4.3 Update checks

The app asks our update server (https://recoverx.snapkio.com/updates/) whether a newer version exists:

- **once after each start**, about 15 seconds after the window opens, while **Check for updates automatically** is on in Settings. It is on unless you turn it off. If a scan or a recovery is running at that moment, the check waits until it has finished. Turning the setting on also checks once, a moment later;
- **whenever you click Check now** under **Updates** on the About screen.

It does not check at any other time. The request carries your IP address, a generic user-agent string ("electron-builder", which names neither you, your computer nor the app's version), and a random identifier that the update component creates on your computer and uses to stage gradual roll-outs. That identifier is not linked to your licence or your computer identifier. Updates are downloaded only when you ask, and installed only when you confirm.

If you installed RecoverX from the Microsoft Store as an MSIX package, updates come from the Microsoft Store instead and the app does not contact our update server.

### 4.4 Our website and downloads

Our website, https://recoverx.snapkio.com, sets no cookies and loads no analytics, advertising, fonts or other content from anyone else. When you visit it or download the installer, and when the app checks for updates, our hosting provider's web servers record standard access-log data: your IP address, the time, the address requested, the result, and the referring page and browser identification your browser sends. We use these logs only to run the website and protect it against abuse.

### 4.5 Crash reports and diagnostics

Crash reports and logs are kept on your computer and are **not sent automatically**. The app has no feature that sends diagnostic or usage data. If you contact support, you may choose to attach your logs or crash reports; they then become part of your support request (section 4.6).

### 4.6 Support

If you email us, we receive whatever you send — typically your email address, your message, and any logs, crash reports or screenshots you attach — and use it to answer you.

### 4.7 Microsoft Store

If you obtained RecoverX from the Microsoft Store, Microsoft processes data about that download under the Microsoft Privacy Statement. Microsoft gives us aggregated statistics (such as numbers of installs, ratings and reviews) and the reviews you choose to publish; it does not give us your identity.

## 5. Why we may use it

Under India's Digital Personal Data Protection Act, 2023, we use the data in section 4 for the purpose for which you gave it to us — activating, delivering, supporting and checking for renewals of the licence you bought, answering your messages and keeping the app up to date — and to keep the accounting records Indian law requires. Where the law requires your consent for something else, we will ask for it, and you may withdraw it at any time.

If the GDPR or the UK GDPR applies to you, our legal bases are: performing our contract with you (activation, delivery, support and renewal of your licence, and updates of the app you licensed); complying with legal obligations (tax and accounting records of purchases); and our legitimate interest in running our website, licence and update services securely and protecting them against fraud and abuse (IP addresses, rate limiting, server logs).

## 6. How long we keep it

| Data                                                                                                                                                                               | Kept for                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence and purchase records: key, edition, the name and email address you gave at purchase, order reference, invoices and payment records                                         | For as long as the licence can be used, then 8 years, as the books of account must be kept under section 128 of the Companies Act, 2013.                                                                |
| Activations: licence key, computer identifier, dates                                                                                                                               | As long as the licence record above. A removed activation is kept as a record that the place was freed.                                                                                                 |
| Licence server records that include IP addresses: the activation event log (activations, removals, automatic removals and renewal checks), the request log and rate-limit counters | 13 months, then deleted. The request log is kept in one file per calendar month, and each file is deleted once the last day of its month is 13 months old.                                              |
| Web server access logs for the website, downloads and update checks, including IP addresses                                                                                        | 30 days on our server, then deleted.                                                                                                                                                                    |
| Support emails and attachments                                                                                                                                                     | 24 months after the request is closed.                                                                                                                                                                  |
| Order requests stored by the licence server, and order emails                                                                                                                      | 24 months after the order was last updated (an order email: after our last reply), then deleted. If you buy, the details needed for the purchase become part of the licence and purchase records above. |
| Data on your computer (section 3)                                                                                                                                                  | Until you delete it or uninstall the app and choose to remove it.                                                                                                                                       |

## 7. Who receives it

We do not sell, rent or share personal data for advertising. We share it only with:

- **Amazon Web Services (AWS)**, our hosting provider, whose servers in Mumbai, India run recoverx.snapkio.com: the website, the download and update files, and the licence server with its database and logs. AWS also sends our emails through Amazon Simple Email Service — licence keys, order forms passed on to our mailboxes and the confirmation you receive — so it handles your email address and the content of those emails. AWS processes this data on our behalf and under our instructions.
- **Our email service providers**, which host the mailboxes we use for orders, licence delivery and support on our behalf: the info@appsgain.in mailbox, and a Google Gmail mailbox that also receives order forms.
- **Our accountants and auditors, and tax authorities**, to the extent Indian law requires for purchase and accounting records.

Microsoft distributes RecoverX through the Microsoft Store and processes data about Store downloads itself (section 4.7); we do not send it data about you. Your bank or payment service processes your payment for you, under its own terms.

We may disclose data when the law requires it, or to protect our rights in a dispute. If our business is transferred, the data would pass to the new owner under this policy.

**International transfers.** Our website, licence server and licence emails run on AWS servers in India (Mumbai). Our email providers (for info@appsgain.in, and Google for Gmail) may store data on servers outside India and outside your country. Indian law permits such transfers except to countries the Government of India has restricted. Where the GDPR or the UK GDPR applies and data is transferred to a country without an adequacy decision, we rely on the safeguards in our providers' data processing terms, such as the European Commission's standard contractual clauses.

## 8. Security

Data travels between the app and our servers only over encrypted HTTPS connections. Activation records are digitally signed so they cannot be forged. The licence database is kept outside the website's public folders, and only the people who need it to run the service can reach it, through a password-protected administration page or our hosting account. Crash reports are stripped of your user name and home folder before they are written.

## 9. Your rights

Depending on where you live, you have the right to ask us for a copy of the personal data we hold about you, to correct it, to delete it, to restrict or object to its use, to withdraw consent, to receive it in a portable form, and to nominate someone to exercise your rights if you cannot. Under India's Digital Personal Data Protection Act, 2023, you may also raise a grievance with our Grievance Officer (section 1) and, if it is not resolved, with the Data Protection Board of India. In the European Economic Area and the United Kingdom you may complain to your data protection authority.

To exercise any of these rights, email info@appsgain.in from the address the licence was bought with, or include your licence key so that we can find your records. We answer within 30 days. Deleting your licence record ends our ability to re-issue or support that licence, and records the law requires us to keep (section 6) are kept until that period ends.

You can always remove your data from your own computer yourself (section 3) and remove a licence from a computer in the app.

## 10. Children

RecoverX is not directed at children, and licences may only be bought by adults. We do not knowingly collect data from children.

## 11. Changes to this policy

We will publish any change here with a new date. If a change affects what the app sends from your computer, we will make the change before the version of the app that does so is released, and describe it in that version's release notes.

## 12. Governing law

This policy is governed by the laws of India. That does not take away any protection the data protection law of your own country gives you.

## 13. Contact

Appsgain Technologies Private Limited, India — info@appsgain.in — https://appsgain.in
