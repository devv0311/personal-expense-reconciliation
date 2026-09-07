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
    <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="sm:min-w-[180px]"
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
