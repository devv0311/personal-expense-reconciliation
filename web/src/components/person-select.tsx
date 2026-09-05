import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="min-w-[180px]"
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
      </Select>
    </div>
  );
}
