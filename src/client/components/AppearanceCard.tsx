import { Check } from "lucide-react";
import { useState } from "react";
import { ACCENTS, saveAccent, savedAccent } from "../lib/accent";
import { Card, CardHeader } from "./ui";

/** Settings → Access: the accent colour, for this person in this browser. */
export function AppearanceCard() {
  const [color, setColor] = useState(savedAccent);
  const pick = (c: string) => (saveAccent(c), setColor(c));
  const custom = !ACCENTS.some((a) => a.color === color);
  return (
    <Card id="appearance" className="scroll-mt-6">
      <CardHeader title="Appearance" description="The accent colour for buttons, links and charts. Saved in this browser, just for you." />
      <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap items-center gap-3 px-4 pb-4">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={color === a.color}
            onClick={() => pick(a.color)}
            className="inline-flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm hover:bg-surface-2 aria-checked:border-fg"
          >
            <span className="grid size-4 place-items-center rounded-full text-white" style={{ background: a.color }}>
              {color === a.color ? <Check className="size-3" /> : null}
            </span>
            {a.label}
          </button>
        ))}
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-surface-2 ${custom ? "border-fg" : "border-line"}`}>
          <input type="color" value={color} onChange={(e) => pick(e.target.value)} className="size-4 cursor-pointer rounded-full border-0 bg-transparent p-0" />
          Custom
        </label>
      </div>
    </Card>
  );
}
