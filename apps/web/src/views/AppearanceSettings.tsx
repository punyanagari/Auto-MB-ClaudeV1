import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  setThemePreference,
  storedThemePreference,
  type ThemePreference,
} from '../lib/theme.js';
import { cn } from '../lib/cn.js';
import { Card, CardHeader } from '../ui/card.js';

const OPTIONS = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const satisfies readonly {
  value: ThemePreference;
  label: string;
  icon: typeof Monitor;
}[];

/** The personal theme choice. This is device state, not tenant data: it is
 * stored in localStorage and applied immediately, and "System" simply
 * follows the operating system's light/dark preference. */
export function AppearanceSettings() {
  const [preference, setPreference] = useState<ThemePreference>(storedThemePreference);

  return (
    <Card className="mx-auto w-full max-w-4xl" aria-labelledby="appearance-title">
      <CardHeader>
        {/* The mock's card section anatomy (`app/settings/page` at
         * fdfe5ef): a 16px medium title over a muted sentence, with the
         * explanation in the header rather than trailing the control. */}
        <div className="flex flex-col gap-1">
          <h2 id="appearance-title" className="m-0 text-base leading-snug font-medium">
            Appearance
          </h2>
          <p className="text-sm text-muted-foreground">
            Saved on this device only. System follows your operating system&rsquo;s
            light or dark preference.
          </p>
        </div>
      </CardHeader>
      <fieldset className="m-0 border-0 p-0">
        <legend className="sr-only">Theme</legend>
        <div
          /* Wraps rather than widening the page: three segments on one
             unbreakable line measured 253px, which does not fit the 246px
             a card leaves on a 320px screen. */
          className="inline-flex flex-wrap rounded-lg border border-input bg-muted p-0.5"
          role="radiogroup"
          aria-label="Theme"
        >
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = preference === option.value;
            return (
              <label
                key={option.value}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
                  selected
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name="theme-preference"
                  value={option.value}
                  checked={selected}
                  className="sr-only"
                  onChange={() => {
                    setPreference(option.value);
                    setThemePreference(option.value);
                  }}
                />
                <Icon className="size-4" aria-hidden="true" />
                {option.label}
              </label>
            );
          })}
        </div>
      </fieldset>
    </Card>
  );
}
