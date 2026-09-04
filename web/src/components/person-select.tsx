import type { PersonSummary } from "@/lib/types";

export function PersonSelect({
  id,
  label,
  people,
  value,
  onChange,
}: {
  id: string;
  label: string;
  people: readonly PersonSummary[];
  value: string | null;
  onChange: (personId: string | null) => void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-[13px] text-ink-muted">
      {label}
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="min-w-[180px] rounded-sm border border-rule bg-panel px-2 py-1.5 text-[14px] text-ink"
      >
        <option value="" disabled>
          Choose a person
        </option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.displayName}
            {person.isUser ? " (you)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
