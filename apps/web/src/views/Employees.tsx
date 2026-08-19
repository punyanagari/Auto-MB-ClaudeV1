import { useEffect, useState } from 'react';
import { Search, Users } from 'lucide-react';
import type { Contact, Employee, EmployeeSummary } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatDate, formatInr } from '../format.js';
import { errorMessage, describeLoadFailure } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { navigateOnClick, PAYROLL_HASH } from '../lib/workspace-routes.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Modal } from '../ui/dialog.js';
import { Actions, Field, FormError, Hint } from '../ui/form.js';
import { DownloadButton } from '../ui/download-button.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { NumericInput } from '../ui/numeric-input.js';

/**
 * The employee register (migrations 0089 and 0090).
 *
 * The mock draws it at `app/employees/page.tsx` through
 * `components/hr/employee-workspace.tsx` at fdfd610, as a six-tab
 * workspace: Directory, Attendance, Leave, Payroll, Payslips and ID
 * cards. This build ships the Directory as the register and the Payroll
 * tab as a screen of its own; the other four are behind features the
 * product does not have, and the mock's own banner says as much about
 * them ("sensitive HR data, photos and attendance are stored only on
 * this browser"). `docs/UX.md` § 15 lists each one and why.
 *
 * No figure here is computed in the browser. Monthly gross arrives as a
 * decimal string the server summed in SQL, and so does every payslip
 * figure on the screen this one links to.
 *
 * ## What the list deliberately does not carry
 *
 * No PAN, no UAN, no ESIC number, no bank account. The list API does not
 * project them (`routes/hr.ts` § EMPLOYEE_SUMMARY_COLUMNS) and this
 * screen could not render them if it wanted to. They are on the detail,
 * behind the same authority, with the account number masked to its last
 * four digits exactly as the mock's own directory masks it.
 */

interface EmployeesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Holds `can_manage_payroll`, which is what gates this whole module
   * — reads included. Without it the screen is never reached. */
  readonly canManagePayroll: boolean;
  /** Role-level write permission, on top of the authority. */
  readonly canModify: boolean;
  readonly onOpenPayroll: () => void;
}

/** Over-fetched by one so the register can say the list is not the whole
 * of it, the way every other keyset register here does. */
const REGISTER_PAGE = 50;

export function Employees({
  api,
  organisationId,
  canManagePayroll,
  canModify,
  onOpenPayroll,
}: EmployeesProps) {
  const [employees, setEmployees] = useState<readonly EmployeeSummary[] | null>(null);
  const [currentCount, setCurrentCount] = useState(0);
  /* Summed by PostgreSQL, not by this page. Adding a column of rupees
     up in JavaScript is exactly the float arithmetic AGENTS.md rule 5
     forbids, and a register total is the easiest place to forget it. */
  const [monthlyGross, setMonthlyGross] = useState('0');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [search, setSearch] = useState('');
  // Debounced so a keystroke is not a request, but the query runs on the
  // SERVER — a browser-only filter over the first page would answer "no
  // match" for an employee at position 130 of a 180-strong register who
  // is on the payroll. The server searches code, name and department
  // across the whole register.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [includeLeavers, setIncludeLeavers] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [loadVersion, reload] = useReload();

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 250);
    return () => {
      clearTimeout(handle);
    };
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setEmployees(null);
    setLoadError(null);
    api
      .listEmployees(organisationId, {
        limit: REGISTER_PAGE,
        status: includeLeavers ? 'all' : 'current',
        ...(debouncedSearch === '' ? {} : { search: debouncedSearch }),
      })
      .then((page) => {
        if (cancelled) return;
        setEmployees(page.employees);
        setCursor(page.nextCursor);
        setCurrentCount(page.currentCount);
        setMonthlyGross(page.currentMonthlyGross);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setEmployees(null);
        setLoadError(describeLoadFailure(cause, 'The employee register').message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, includeLeavers, debouncedSearch, loadVersion]);

  const loadMore = () => {
    if (cursor === null) return;
    setPaging(true);
    api
      .listEmployees(organisationId, {
        limit: REGISTER_PAGE,
        cursor,
        status: includeLeavers ? 'all' : 'current',
        ...(debouncedSearch === '' ? {} : { search: debouncedSearch }),
      })
      .then((page) => {
        setEmployees((current) => [...(current ?? []), ...page.employees]);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        setLoadError(describeLoadFailure(cause, 'The employee register').message);
      })
      .finally(() => {
        setPaging(false);
      });
  };

  // The server has already filtered by the debounced search; the page IS
  // the result, so there is no browser-side filter to disagree with it.
  const shown = employees ?? [];
  const searching = debouncedSearch !== '';

  const header = (
    <PageHeader
      eyebrow="People and payroll"
      title="Employees"
      titleId="employees-title"
      description="Who is on the payroll, what they are paid, and how the statute treats them. Attendance and leave are not recorded here."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <DownloadButton
            label="Export .xlsx"
            filename="employees.xlsx"
            fetchBlob={() => api.downloadRegisterWorkbook(organisationId, 'employees')}
            {...(search !== ''
              ? { note: 'Exports every employee, not the search on screen.' }
              : {})}
          />
          {/* A real anchor with a hash href, not a button with a handler:
              `docs/UX.md` § navigation asks that every mock Link become
              an address middle-click and open-in-new-tab can use. */}
          <a
            href={PAYROLL_HASH}
            onClick={navigateOnClick(onOpenPayroll)}
            className={buttonVariants({ variant: 'outline' })}
          >
            <Users data-icon="inline-start" aria-hidden="true" />
            Monthly payroll
          </a>
          {canModify && (
            <Button
              onClick={() => {
                setComposerOpen(true);
              }}
            >
              New employee
            </Button>
          )}
        </div>
      }
    />
  );

  if (loadError !== null && employees === null) {
    return (
      <>
        {header}
        <ErrorState onRetry={reload} retryLabel="Retry the employee register">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (employees === null) {
    return (
      <>
        {header}
        <LoadingState label="the employee register" rows={6} columns={5} />
      </>
    );
  }

  return (
    <>
      {header}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <Stat
            label="On the payroll"
            value={String(currentCount)}
            hint="Employed today"
          />
        </Card>
        <Card>
          <Stat
            label="Monthly gross"
            value={formatInr(monthlyGross)}
            hint="Full-attendance entitlement of everybody employed"
          />
        </Card>
      </div>

      <Card className="mt-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex min-w-56 flex-1 items-center gap-2">
            <Search className="size-4 text-muted-foreground" aria-hidden="true" />
            <label className="sr-only" htmlFor="employee-search">
              Search employees
            </label>
            <input
              id="employee-search"
              className="input"
              placeholder="Search name, code or department"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeLeavers}
              onChange={(event) => {
                setIncludeLeavers(event.target.checked);
              }}
            />
            Include people who have left
          </label>
        </div>

        {shown.length === 0 ? (
          <EmptyState>
            {searching
              ? 'No employee matches that search.'
              : 'Nobody is on the payroll yet. An employee is a contact from Masters with employment and salary details recorded against them.'}
          </EmptyState>
        ) : (
          <DataTable>
            <caption className="sr-only">
              Every employee, with the monthly entitlement their payroll is computed
              from and how the provident fund and insurance treat them
            </caption>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Department</th>
                <th scope="col">Joined</th>
                <th scope="col" className="text-right!">
                  Monthly gross
                </th>
                <th scope="col">Statutory cover</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((employee) => (
                <tr key={employee.id}>
                  <th scope="row" className={wrapCell}>
                    <span className="block font-medium">{employee.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {employee.employeeCode}
                      {employee.designation === null
                        ? ''
                        : ` · ${employee.designation}`}
                    </span>
                  </th>
                  <td>{employee.department ?? '—'}</td>
                  <td className="font-mono text-[13px] tabular-nums">
                    {formatDate(employee.dateOfJoining)}
                  </td>
                  <td className={numericCell}>{formatInr(employee.monthlyGross)}</td>
                  <td className="text-xs">
                    {/* Words, not ticks. "PF" beside a green dot and
                        nothing beside a grey one would put the meaning on
                        the colour, and a payslip's statutory cover is
                        exactly the fact somebody reads in a hurry. */}
                    {[
                      employee.pfCovered ? 'Provident fund' : null,
                      employee.esiApplicable ? 'ESI' : null,
                    ]
                      .filter((label) => label !== null)
                      .join(' · ') || 'Neither'}
                  </td>
                  <td>
                    <StatusChip status={employee.employed ? 'active' : 'inactive'}>
                      {employee.employed ? 'Employed' : 'Left'}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        {loadError !== null && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {loadError}
          </div>
        )}

        {cursor !== null && (
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            disabled={paging}
            onClick={loadMore}
          >
            {paging ? 'Loading…' : 'Load more employees'}
          </Button>
        )}
      </Card>

      {composerOpen && canManagePayroll && (
        <EmployeeComposer
          api={api}
          organisationId={organisationId}
          onClose={() => {
            setComposerOpen(false);
          }}
          onCreated={() => {
            setComposerOpen(false);
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * The create form.
 *
 * It names an EXISTING contact rather than collecting a name, a phone
 * number and a bank account of its own. The mock's dialog collects all
 * three, and here they live on the `contacts` row (migrations 0028, 0078,
 * 0080) — a second form writing the same columns is how two masters start
 * disagreeing, and the payments workspace pays a contact, so an employee
 * who is not one could never be paid at all.
 */
function EmployeeComposer({
  api,
  organisationId,
  onClose,
  onCreated,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onClose: () => void;
  readonly onCreated: (employee: Employee) => void;
}) {
  const [contacts, setContacts] = useState<readonly Contact[]>([]);
  const [contactId, setContactId] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [department, setDepartment] = useState('');
  const [dateOfJoining, setDateOfJoining] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [pfCovered, setPfCovered] = useState(true);
  const [pfWageBasis, setPfWageBasis] = useState<'actual' | 'ceiling'>('ceiling');
  const [esiApplicable, setEsiApplicable] = useState(true);
  const [ptState, setPtState] = useState('27');
  const [ptCategory, setPtCategory] = useState<'male' | 'female' | ''>('');
  const [taxRegime, setTaxRegime] = useState<'old' | 'new'>('new');
  const [basic, setBasic] = useState('');
  const [da, setDa] = useState('0');
  const [hra, setHra] = useState('0');
  const [other, setOther] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.listContacts(organisationId, {});
        if (!cancelled) setContacts(rows.filter((contact) => contact.isEmployee));
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  const ready =
    contactId !== '' &&
    employeeCode.trim() !== '' &&
    dateOfJoining !== '' &&
    dateOfBirth !== '' &&
    basic.trim() !== '' &&
    (ptState === '' || ptCategory !== '');

  const submit = () => {
    setPending(true);
    setError(null);
    api
      .createEmployee(organisationId, {
        contactId,
        employeeCode: employeeCode.trim(),
        department: department.trim() === '' ? null : department.trim(),
        dateOfJoining,
        dateOfBirth,
        pfCovered,
        pfWageBasis,
        esiApplicable,
        professionalTaxStateCode: ptState === '' ? null : ptState,
        professionalTaxCategory: ptCategory === '' ? null : ptCategory,
        taxRegime,
        basicMonthly: basic.trim(),
        dearnessAllowanceMonthly: da.trim() === '' ? '0' : da.trim(),
        houseRentAllowanceMonthly: hra.trim() === '' ? '0' : hra.trim(),
        otherAllowancesMonthly: other.trim() === '' ? '0' : other.trim(),
      })
      .then((payload) => {
        onCreated(payload.employee);
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause, 'The employee could not be saved.'));
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <Modal
      onClose={onClose}
      labelledBy="employee-composer-title"
      className="w-full max-w-2xl"
      lockScroll
    >
      <h2 id="employee-composer-title" className="m-0 text-base font-semibold">
        New employee
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Employment, statutory treatment and the monthly salary structure. The name,
        contact details, PAN and bank account are the contact&rsquo;s, and are edited in
        Masters.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field>
          <label htmlFor="employee-contact">Contact</label>
          <select
            id="employee-contact"
            className="input"
            value={contactId}
            onChange={(event) => {
              setContactId(event.target.value);
            }}
          >
            <option value="">Choose a person</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.designation}
              </option>
            ))}
          </select>
          {contacts.length === 0 && (
            <Hint>
              No contact carries the employee role yet. Mark one in Masters, Contacts
              first — a salary is paid to a contact, so an employee has to be one.
            </Hint>
          )}
        </Field>
        <Field>
          <label htmlFor="employee-code">Employee code</label>
          <input
            id="employee-code"
            className="input font-mono"
            value={employeeCode}
            onChange={(event) => {
              setEmployeeCode(event.target.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="employee-department">Department</label>
          <input
            id="employee-department"
            className="input"
            value={department}
            onChange={(event) => {
              setDepartment(event.target.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="employee-joined">Date of joining</label>
          <input
            id="employee-joined"
            type="date"
            className="input"
            value={dateOfJoining}
            onChange={(event) => {
              setDateOfJoining(event.target.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="employee-born">Date of birth</label>
          <input
            id="employee-born"
            type="date"
            className="input"
            value={dateOfBirth}
            onChange={(event) => {
              setDateOfBirth(event.target.value);
            }}
          />
          <Hint>
            The old income-tax regime&rsquo;s basic exemption rises at sixty and again
            at eighty, so a run cannot pick the right slab ladder without it.
          </Hint>
        </Field>
        <Field>
          <label htmlFor="employee-regime">Income-tax regime</label>
          <select
            id="employee-regime"
            className="input"
            value={taxRegime}
            onChange={(event) => {
              setTaxRegime(event.target.value as 'old' | 'new');
            }}
          >
            <option value="new">New regime (section 115BAC)</option>
            <option value="old">Old regime</option>
          </select>
        </Field>

        <div className="sm:col-span-2 border-t pt-4">
          <h3 className="m-0 text-sm font-medium">Statutory treatment</h3>
        </div>

        <Field>
          <label htmlFor="employee-pf">Provident fund</label>
          <select
            id="employee-pf"
            className="input"
            value={pfCovered ? pfWageBasis : 'excluded'}
            onChange={(event) => {
              const value = event.target.value;
              setPfCovered(value !== 'excluded');
              if (value !== 'excluded') setPfWageBasis(value as 'actual' | 'ceiling');
            }}
          >
            <option value="ceiling">Covered, on the statutory ceiling</option>
            <option value="actual">Covered, on the whole wage</option>
            <option value="excluded">Excluded employee</option>
          </select>
        </Field>
        <Field>
          <label htmlFor="employee-esi">Employees&rsquo; State Insurance</label>
          <select
            id="employee-esi"
            className="input"
            value={esiApplicable ? 'yes' : 'no'}
            onChange={(event) => {
              setEsiApplicable(event.target.value === 'yes');
            }}
          >
            <option value="yes">Establishment is covered</option>
            <option value="no">Outside the Act</option>
          </select>
          <Hint>
            Whether the deduction is made in a given month still turns on that
            month&rsquo;s gross against the wage ceiling.
          </Hint>
        </Field>
        <Field>
          <label htmlFor="employee-pt-state">Profession-tax State</label>
          <select
            id="employee-pt-state"
            className="input"
            value={ptState}
            onChange={(event) => {
              setPtState(event.target.value);
              if (event.target.value === '') setPtCategory('');
            }}
          >
            <option value="27">Maharashtra</option>
            <option value="">No profession tax</option>
          </select>
          <Hint>
            Only Maharashtra&rsquo;s schedule is recorded. Another State&rsquo;s has to
            be added before a run there will compute.
          </Hint>
        </Field>
        <Field>
          <label htmlFor="employee-pt-category">Schedule arm</label>
          <select
            id="employee-pt-category"
            className="input"
            value={ptCategory}
            disabled={ptState === ''}
            onChange={(event) => {
              setPtCategory(event.target.value as 'male' | 'female' | '');
            }}
          >
            <option value="">Choose</option>
            <option value="male">Men&rsquo;s schedule</option>
            <option value="female">Women&rsquo;s schedule</option>
          </select>
          <Hint>
            Maharashtra exempts women below ₹25,000 a month and men below ₹7,500, so the
            schedule cannot be resolved without knowing which entry applies.
          </Hint>
        </Field>

        <div className="sm:col-span-2 border-t pt-4">
          <h3 className="m-0 text-sm font-medium">Monthly salary structure</h3>
          <p className="m-0 text-sm text-muted-foreground">
            The entitlement at full attendance. Basic and dearness allowance are the
            provident-fund wage; all four are the insurance and income-tax base.
          </p>
        </div>

        <Field>
          <label htmlFor="employee-basic">Basic</label>
          <NumericInput
            id="employee-basic"
            className="input font-mono tabular-nums"
            value={basic}
            onChange={(event) => {
              setBasic(event.target.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="employee-da">Dearness allowance</label>
          <NumericInput
            id="employee-da"
            className="input font-mono tabular-nums"
            value={da}
            onChange={(event) => {
              setDa(event.target.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="employee-hra">House rent allowance</label>
          <NumericInput
            id="employee-hra"
            className="input font-mono tabular-nums"
            value={hra}
            onChange={(event) => {
              setHra(event.target.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="employee-other">Other allowances</label>
          <NumericInput
            id="employee-other"
            className="input font-mono tabular-nums"
            value={other}
            onChange={(event) => {
              setOther(event.target.value);
            }}
          />
        </Field>
      </div>

      {error !== null && <FormError>{error}</FormError>}

      <Actions>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={pending || !ready} onClick={submit}>
          {pending ? 'Saving…' : 'Save employee'}
        </Button>
      </Actions>
    </Modal>
  );
}
