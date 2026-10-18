"use client";

import { Account, Client, ID, Models, Query, Storage, TablesDB } from "appwrite";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import ProfileSelector, { preferredProfileId, selectedProfileStorageKey } from "../ProfileSelector";

type Profile = Models.Row & { name: string; identityId?: string };
type CloudMessage = Models.Row & {
  messageUuid: string;
  from: string;
  to: string;
  text: string;
  timestampMs: number;
  status: string;
  deliveryState: string;
  attachmentFileId?: string;
  attachmentKind?: string;
  attachmentName?: string;
};

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!);
const account = new Account(client);
const tables = new TablesDB(client);
const storage = new Storage(client);
const databaseId = process.env.NEXT_PUBLIC_DATABASE_ID!;
const messageTableId = process.env.NEXT_PUBLIC_MESSAGE_TABLE_ID!;
const attachmentBucketId = process.env.NEXT_PUBLIC_MESSAGE_ATTACHMENT_BUCKET_ID!;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function relativeTime(timestampMs: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function MessagesPage() {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [email, setEmail] = useState("");
  const [otpUserId, setOtpUserId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpPhrase, setOtpPhrase] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const loadProfiles = useCallback(async () => {
    const result = await tables.listRows<Profile>({ databaseId, tableId: "profiles", queries: [Query.limit(100)] });
    setProfiles([...result.rows].sort((left, right) => left.name.localeCompare(right.name)));
  }, []);

  useEffect(() => {
    account.get().then(async (current) => { setUser(current); await loadProfiles(); })
      .catch(() => undefined).finally(() => setBusy(false));
  }, [loadProfiles]);

  useEffect(() => {
    if (!user || !profiles.length) return;
    setProfileId((current) => profiles.some((profile) => profile.$id === current)
      ? current
      : preferredProfileId(user.$id, profiles, (user.prefs as { currentProfileId?: string }).currentProfileId));
  }, [profiles, user]);

  useEffect(() => {
    if (!user || !profileId) return;
    window.localStorage.setItem(selectedProfileStorageKey(user.$id), profileId);
  }, [profileId, user]);

  const profile = profiles.find((candidate) => candidate.$id === profileId);

  useEffect(() => {
    const identityId = profile?.identityId;
    if (!identityId) { setMessages([]); return; }
    let active = true;
    const load = () => tables.listRows<CloudMessage>({
      databaseId,
      tableId: messageTableId,
      queries: [
        Query.or([Query.equal("from", [identityId]), Query.equal("to", [identityId])]),
        Query.orderDesc("timestampMs"),
        Query.limit(500),
      ],
    }).then((result) => { if (active) setMessages(result.rows); })
      .catch((caught) => { if (active) setError(messageOf(caught)); });
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [profile?.identityId]);

  const conversations = useMemo(() => {
    const identityId = profile?.identityId || "";
    const groups = new Map<string, CloudMessage[]>();
    for (const item of messages) {
      const peer = item.from === identityId ? item.to : item.from;
      groups.set(peer, [...groups.get(peer) || [], item]);
    }
    return [...groups.entries()].map(([peer, items]) => ({
      peer,
      items: items.sort((left, right) => right.timestampMs - left.timestampMs),
    })).sort((left, right) => (right.items[0]?.timestampMs || 0) - (left.items[0]?.timestampMs || 0));
  }, [messages, profile?.identityId]);

  async function requestOtp() {
    setBusy(true); setError("");
    try {
      const token = await account.createEmailToken({ userId: ID.unique(), email, phrase: true });
      setOtpUserId(token.userId); setOtpPhrase(token.phrase || "");
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }

  async function verifyOtp() {
    setBusy(true); setError("");
    try {
      await account.createSession({ userId: otpUserId, secret: otpCode });
      const current = await account.get();
      setUser(current);
      await loadProfiles();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await account.deleteSession({ sessionId: "current" });
    setUser(null); setProfiles([]); setProfileId(""); setMessages([]); setOtpUserId(""); setOtpCode(""); setOtpPhrase("");
  }

  return <main className="shell">
    <header className="topbar"><span className="mark">L</span><strong>Offgrid Tracker</strong>{user && <nav className="topnav" aria-label="Primary navigation"><Link href="/">Devices</Link><Link className="active" href="/messages">Messages</Link><Link href="/topology">Topology</Link></nav>}{user && <ProfileSelector profiles={profiles} value={profileId} onChange={setProfileId} />}{user && <button className="link" onClick={() => void signOut()}>Sign out</button>}</header>
    {!user ? <section className="auth-grid">
      <div><p className="eyebrow">PRIVATE CLOUD MESSAGES</p><h1>Conversations,<br /><em>synced.</em></h1><p className="lede">Sign in with email OTP to view messages belonging to your active profile identity.</p></div>
      <form className="panel" onSubmit={(event) => { event.preventDefault(); void (otpUserId ? verifyOtp() : requestOtp()); }}>
        <h2>Operator access</h2>
        {!otpUserId ? <><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label><div className="actions"><button disabled={busy}>{busy ? "Sending…" : "Send email code"}</button></div></> : <><p className="otp-help">Enter the six-digit code sent to <strong>{email}</strong>.{otpPhrase ? <> Confirm the email shows <strong>{otpPhrase}</strong>.</> : null}</p><label>Email code<input inputMode="numeric" autoComplete="one-time-code" value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} minLength={6} maxLength={6} required autoFocus /></label><div className="actions"><button disabled={busy || otpCode.length !== 6}>{busy ? "Verifying…" : "Verify code"}</button><button className="secondary" type="button" disabled={busy} onClick={() => { setOtpUserId(""); setOtpCode(""); setOtpPhrase(""); }}>Use another email</button></div></>}
      </form>
    </section> : <section className="messages-dashboard">
      <div className="heading-row"><div><p className="eyebrow">{profile?.name || "SELECT A PROFILE"} · SIGNED IN AS {user.email}</p><h1>Messages</h1></div><span className="count">{messages.length} MESSAGES · {conversations.length} CONVERSATIONS</span></div>
      <div className="conversation-list">{conversations.map(({ peer, items }) => <section className="conversation-card" key={peer}>
        <header><div><span>CONVERSATION WITH</span><strong>{peer}</strong></div><time>{relativeTime(items[0]!.timestampMs)}</time></header>
        <div>{items.map((item) => {
          const mine = item.from === profile?.identityId;
          return <article className={mine ? "message-row mine" : "message-row"} key={item.$id}>
            <div><strong>{mine ? "You" : item.from}</strong><time>{new Date(item.timestampMs).toLocaleString()}</time></div>
            <p>{item.text || (item.attachmentKind ? `${item.attachmentKind} attachment` : "Empty message")}</p>
            <footer><span>{item.deliveryState || item.status}</span>{item.attachmentFileId && <a href={storage.getFileDownload({ bucketId: attachmentBucketId, fileId: item.attachmentFileId })} download={item.attachmentName || undefined}>Download {item.attachmentKind || "attachment"}</a>}</footer>
          </article>;
        })}</div>
      </section>)}{!conversations.length && <p className="empty">No cloud-synced messages for this profile identity.</p>}</div>
    </section>}
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}
