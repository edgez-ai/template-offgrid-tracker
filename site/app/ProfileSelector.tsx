"use client";

export type ProfileOption = { $id: string; name: string };

export const selectedProfileStorageKey = (userId: string) => `offgrid-tracker:selected-profile:${userId}`;

export function preferredProfileId(userId: string, profiles: ProfileOption[], accountPreference = "") {
  const stored = window.localStorage.getItem(selectedProfileStorageKey(userId)) || "";
  return [stored, accountPreference, profiles[0]?.$id || ""].find((candidate) =>
    profiles.some((profile) => profile.$id === candidate)) || "";
}

export default function ProfileSelector({ profiles, value, onChange }: {
  profiles: ProfileOption[];
  value: string;
  onChange: (profileId: string) => void;
}) {
  return <label className="profile-selector">
    <span>Profile</span>
    <select aria-label="Current profile" value={value} onChange={(event) => onChange(event.target.value)} disabled={!profiles.length}>
      {!profiles.length && <option value="">No profiles</option>}
      {profiles.map((profile) => <option key={profile.$id} value={profile.$id}>{profile.name}</option>)}
    </select>
  </label>;
}
