SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0092: telling somebody something — the channels the
-- organisation may speak through, the templates it is allowed to say, the
-- consent that permits each recipient to be spoken to, and the log of
-- every message it actually sent.
--
-- WhatsApp is the PRIMARY channel and email is the secondary one. That
-- ordering is a fact about the customer, not a preference: an Indian
-- Railways contractor's counterparties read WhatsApp within minutes and
-- read email when somebody remembers to open Outlook. Email is kept
-- because a WhatsApp template can be rejected, a number can be
-- un-consented, and a notification with no second road is a notification
-- that silently does not arrive.
--
-- FOUR TABLES.
--
--   notification_channels   what this organisation may send through
--   notification_templates  what it is allowed to say, per Meta's lifecycle
--   notification_consents   who has agreed to be spoken to, per channel
--   notification_messages   what was actually sent, and what became of it
--
-- ---------------------------------------------------------------------
-- WHAT IS NOT IN THIS SCHEMA, AND WILL NEVER BE: THE CREDENTIALS.
--
-- No access token, no app secret, no SMTP password. The WhatsApp Business
-- API access token and the app secret that signs Meta's webhooks are
-- DEPLOYMENT configuration, read from the environment into an injected
-- adapter, exactly as 0053's Whitebooks transport is
-- (`apps/server/src/gsp/statutory-provider.ts`: "credentials live inside
-- the injected adapter and are never accepted by HTTP routes or
-- persisted"). The same posture for the same reason: a secret in a tenant
-- table is a secret in the organisation's own export, in every backup, and
-- behind whatever the Settings screen's authority check happens to be
-- this month.
--
-- What IS here is the part that identifies the organisation rather than
-- authenticates it — the WABA phone number id, the business account id,
-- the sender address. Those are per-organisation, an operator must be able
-- to read them back to compare against the Meta console, and none of them
-- is a credential.
--
-- Meta onboarding was still in flight when this landed. That is why the
-- transport is an interface with a test double and not a hard dependency:
-- the schema, the rules, the register and the screens are provable today,
-- and the day the WABA is approved the only new thing is an environment
-- block.
--
-- ---------------------------------------------------------------------
-- CONSENT IS PER ADDRESS, NOT PER PERSON, AND THAT IS THE WHOLE POINT.
--
-- A consent row names a contact, a channel AND the address the agreement
-- was given for. Change the contact's phone number in the masters and the
-- consent no longer matches: the next send is refused rather than
-- delivered to whoever now holds that number.
--
-- The alternative — consent as a boolean on the contact — was considered
-- and refused. It reads the same on the screen and is wrong in the one
-- case that matters, which is the case that actually happens: a railway
-- office's mobile number is reassigned when the officer is transferred,
-- and a "consented" flag would carry an agreement made by one person into
-- messages sent to another. A stale consent is not a smaller problem than
-- no consent; it is the same problem wearing a green lamp.
--
-- ---------------------------------------------------------------------
-- THE DELIVERY LOG IS A LEDGER, AND ITS STATUS ONLY EVER GOES FORWARDS.
--
--   queued     the row exists, the provider has not been called yet
--   sent       the provider accepted it and named it
--   delivered  the handset acknowledged it
--   read       the recipient opened it
--   failed     terminal, carrying the provider's own code
--
-- Written BEFORE the provider call and completed after it, which is
-- 0053's `startStatutoryOperation` / `finishStatutoryOperation` shape and
-- is here for the same reason: a process that dies between "we called
-- Meta" and "Meta answered" must leave evidence that it called, or the
-- operator is left asking a question the system cannot answer.
--
-- Meta's webhooks arrive out of order and more than once. `delivered`
-- after `read` is a routine occurrence, not an error, and the guard
-- treats a receipt that would move the row backwards as a no-op rather
-- than a refusal — see `app_private.record_notification_receipt`.
--
-- ---------------------------------------------------------------------
-- WHAT THIS PACK DELIBERATELY DOES NOT MODEL.
--
-- No Work reference. A notification in this pack is organisation-level:
-- "your template was approved", "here is a test message". Delivering a
-- DOCUMENT over WhatsApp is the next pack's outcome, and it is the thing
-- that makes a message a fact about a Work — at which point the column,
-- its composite foreign key, its work-scope arm in the register and its
-- entry in the supersession census all arrive together and mean
-- something. Adding a nullable `work_id` here would add four census
-- entries whose honest answer today is "no row ever sets it".
--
-- No inbound messages. Meta's webhook carries replies as well as
-- receipts; this receiver reads the `statuses` array and ignores the
-- `messages` array. Parsing a reply means deciding what "STOP" does to a
-- consent row, and that is a rule the owner has to state before it is
-- coded, not one to infer from a keyword list.
--
-- No queue. A send happens inside the request that asks for it. The
-- worker job queue (0072) is another pack's surface this wave, and a
-- notification that is slow is a worse problem than a notification that
-- is synchronous.
--
-- ---------------------------------------------------------------------
-- THE NOTIFICATIONS AUTHORITY.
--
-- Owner ruling pattern of 0089 and 0091: its own column, granted per
-- member, defaulting to false and NOT backfilled, with the founding owner
-- holding it because `create_organisation_with_owner` says so.
--
-- Why it is not `issue`: configuring a channel decides which phone number
-- the organisation speaks from, and recording a consent decides who may
-- be spoken to. Neither is issuing a document, and a member trusted to
-- sign off a challan is not thereby trusted to point the organisation's
-- outbound voice at a different number.

ALTER TABLE organisation_memberships
  ADD COLUMN can_manage_notifications boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organisation_memberships.can_manage_notifications IS
  'Authority to configure notification channels, maintain message templates, record recipient consent and send a message (0092). Separate from can_issue_documents: issuing a document commits the organisation''s words to a counterparty who asked for them, and choosing the number those words leave from — and who else may be messaged — is a different decision. Not backfilled: an owner grants it per member.';

-- THE FOUNDING OWNER HOLDS IT, and every existing member does not — the
-- 0091 asymmetry, for the 0091 reason.
--
-- CROSS-PACK HAZARD, STATED LOUDLY BECAUSE IT HAS ALREADY BITTEN ONCE.
-- This is the FOURTH migration to replace this function (0089 added
-- can_manage_payroll, 0091 added can_sign_documents), and a CREATE OR
-- REPLACE states the whole body rather than amending it. Every grant
-- below is restated. Migrations 0094, 0095 and 0096 are being authored in
-- parallel against this same function; whichever applies last must carry
-- every authority named here plus its own, and the merge is where that is
-- checked. A founder silently missing an authority produces no error
-- anywhere, because nothing refuses a column left false.
CREATE OR REPLACE FUNCTION app_private.create_organisation_with_owner(
  p_name text,
  p_slug text,
  p_id uuid DEFAULT gen_random_uuid()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
DECLARE
  v_user_id text;
BEGIN
  v_user_id := nullif(current_setting('app.user_id', true), '');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'organisation creation requires an authenticated user context'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO organisations (id, name, slug) VALUES (p_id, p_name, p_slug);

  -- Four authorities, three of them inherited from earlier replacements.
  INSERT INTO organisation_memberships (
    organisation_id, user_id, role, work_scope,
    can_issue_documents, can_cancel_documents, can_sign_documents,
    can_manage_payroll, can_manage_notifications, status
  )
  VALUES (p_id, v_user_id, 'owner', 'all', true, true, true, true, true, 'active');

  INSERT INTO audit_events (
    organisation_id, actor_user_id, action, entity_type, entity_id
  )
  VALUES (p_id, v_user_id, 'organisation.created', 'organisations', p_id);

  RETURN p_id;
END
$$;

-- CREATE OR REPLACE keeps the existing owner and grants; both are stated
-- anyway, because a SECURITY DEFINER function that silently changed hands
-- would be a privilege change nobody reviewed.
ALTER FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION
      app_private.create_organisation_with_owner(text, text, uuid) TO auto_mb_app;
  END IF;
END
$$;

-- The shared throttle gains a fifth scope (0054, extended by 0091).
--
-- The webhook receiver is a public address: anyone who learns the URL can
-- post to it, and every post costs a signature verification before it can
-- be refused. It is throttled per address like the login, upload and kiosk
-- surfaces, and the window is sized against Meta's own behaviour — a busy
-- organisation's receipts arrive in bursts of a few dozen — rather than
-- borrowed from the auth rule, which would drop real receipts.
ALTER TABLE rate_limit_attempts
  DROP CONSTRAINT rate_limit_attempts_scope_check;
ALTER TABLE rate_limit_attempts
  ADD CONSTRAINT rate_limit_attempts_scope_check
  CHECK (scope IN ('auth', 'upload', 'account_lockout', 'signing', 'notification_webhook'));

-- ---------------------------------------------------------------------
-- 1. The channels.
--
-- One row per organisation per channel, so "is WhatsApp configured here"
-- is a lookup rather than a scan, and so an organisation that has email
-- working and WhatsApp half-configured is a state the schema can hold.
--
-- WHY `enabled` IS SEPARATE FROM "THE FIELDS ARE FILLED IN". Meta
-- onboarding takes weeks and arrives in pieces: the business account id
-- comes first, the phone number id after verification, the templates
-- after review. An operator needs to record each fact as it lands without
-- the product starting to send from a half-built configuration. So the
-- shape CHECKs say what a COMPLETE configuration looks like, and `enabled`
-- says whether to use it — and the guard refuses to enable an incomplete
-- one.
--
-- `api_base_url` NULL means Meta Cloud API direct, which is the default
-- and the assumption throughout. A value means a BSP fronting the same
-- API. It is a base URL and not a provider name because that is the only
-- thing that actually differs: a BSP that is not wire-compatible with the
-- Cloud API is a different adapter, not a different column.
-- ---------------------------------------------------------------------
CREATE TABLE notification_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  enabled boolean NOT NULL DEFAULT false,

  -- WhatsApp. Meta's identifiers are opaque decimal strings; the display
  -- number is E.164 because that is what an operator recognises and what
  -- the Meta console shows beside it.
  waba_phone_number_id text CHECK (waba_phone_number_id ~ '^[0-9]{5,32}$'),
  waba_business_account_id text CHECK (waba_business_account_id ~ '^[0-9]{5,32}$'),
  display_phone_number text CHECK (display_phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  -- NULL = Meta Cloud API direct. https only: this carries an access token
  -- in an Authorization header on every call.
  api_base_url text CHECK (
    api_base_url IS NULL
    OR (api_base_url LIKE 'https://%' AND length(api_base_url) BETWEEN 12 AND 400)
  ),

  -- Email. The transport is SMTP, which is what every relay offers and
  -- what the password-recovery path (apps/server/src/auth.ts) already
  -- speaks; an SES deployment configures its SMTP endpoint rather than
  -- adding an AWS SDK.
  from_address text CHECK (
    from_address IS NULL
    OR (
      btrim(from_address) = from_address
      AND length(from_address) BETWEEN 3 AND 200
      AND position('@' in from_address) > 1
    )
  ),
  reply_to_address text CHECK (
    reply_to_address IS NULL
    OR (
      btrim(reply_to_address) = reply_to_address
      AND length(reply_to_address) BETWEEN 3 AND 200
      AND position('@' in reply_to_address) > 1
    )
  ),

  configured_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, channel),

  -- Each channel carries only its own fields. A row is not allowed to be
  -- half a WhatsApp configuration and half an email one, because the
  -- register would then have to guess which half to believe.
  CONSTRAINT notification_channels_shape CHECK (
    CASE channel
      WHEN 'whatsapp' THEN from_address IS NULL AND reply_to_address IS NULL
      WHEN 'email' THEN
        waba_phone_number_id IS NULL AND waba_business_account_id IS NULL
        AND display_phone_number IS NULL AND api_base_url IS NULL
      ELSE false
    END
  )
);

-- GLOBALLY unique, not per organisation, and partial because most rows
-- have no phone number id at all. Meta's webhook names the phone number
-- id and nothing else this server can resolve a tenant from, so the value
-- has to identify one row in the cluster — the same argument
-- `signing_agents.token_hash` makes.
CREATE UNIQUE INDEX notification_channels_waba_phone_number_id_key
  ON notification_channels (waba_phone_number_id)
  WHERE waba_phone_number_id IS NOT NULL;

COMMENT ON TABLE notification_channels IS
  'What one organisation may send notifications through. Identity, never credentials: the WhatsApp access token and the webhook app secret are deployment environment, read into an injected adapter, so that no secret is ever in a tenant table, an export or a backup.';
COMMENT ON COLUMN notification_channels.enabled IS
  'Whether to actually send through this channel. Separate from whether the fields are filled in, because Meta onboarding arrives in pieces over weeks and an operator must be able to record each fact as it lands without the product starting to send from a half-built configuration.';
COMMENT ON COLUMN notification_channels.api_base_url IS
  'NULL means Meta Cloud API direct, which is the default. A value fronts the same wire protocol through a BSP. A BSP that is not Cloud-API-compatible is a different adapter, not a different value here.';

ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_channels FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY notification_channels_tenant_policy ON notification_channels
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: a channel that was configured is what every historical
-- message in the log was sent through, and the log names the channel by
-- word rather than by key precisely so this stays true — but removing the
-- configuration would still erase the answer to "what number did we send
-- from in March". Disabling is the operation.
GRANT SELECT, INSERT, UPDATE ON notification_channels TO auto_mb_app;

-- The definer role reads this table through
-- app_private.record_notification_receipt below. BYPASSRLS lifts the
-- POLICY, not the table privilege, so the grant is separate and is SELECT
-- only — 0091 grants signing_agents the same way for the same reason.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_definer') THEN
    GRANT SELECT ON notification_channels TO auto_mb_definer;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. The templates.
--
-- A WhatsApp business-initiated message may only be a template Meta has
-- approved. That is not this product's rule and cannot be argued with, so
-- the lifecycle is modelled as Meta states it:
--
--   draft      local only; never submitted
--   pending    submitted, under review
--   approved   sendable
--   rejected   refused, with Meta's reason
--   paused     approved but throttled by Meta for poor quality
--   disabled   approved then withdrawn by Meta
--
-- The status is RECORDED BY A MEMBER reading the Meta console, not
-- discovered by polling. There is no template-management API call in this
-- pack, because the WABA it would call does not exist yet; when it does,
-- the column it writes is already here and already means the right thing.
--
-- ONE TABLE FOR BOTH CHANNELS, and the seam is which columns are filled.
-- `body_text` carries Meta's own `{{1}}` placeholders and is what both
-- channels render; `email_subject` is the one thing email needs and
-- WhatsApp has no room for. A template with no subject is not sendable by
-- email; a template that is not `approved` is not sendable by WhatsApp.
-- Neither rule gates the other, which is what lets an organisation with no
-- WABA still send email.
-- ---------------------------------------------------------------------
CREATE TABLE notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- Meta's template name rules, enforced here so a name that cannot be
  -- submitted is refused at the moment somebody types it rather than
  -- weeks later at review.
  name text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,512}$'),
  -- Meta's language code: 'en', 'en_US', 'hi'. A template is identified by
  -- name AND language at the WABA, and so it is here.
  language text NOT NULL CHECK (language ~ '^[a-z]{2}(_[A-Z]{2})?$'),

  category text NOT NULL CHECK (
    category IN ('utility', 'marketing', 'authentication')
  ),
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled')
  ),
  -- Meta's own words for why it refused, copied by the member who read
  -- them. Free text because Meta's reasons are prose.
  status_reason text CHECK (
    status_reason IS NULL
    OR (btrim(status_reason) = status_reason AND length(status_reason) BETWEEN 1 AND 500)
  ),

  body_text text NOT NULL CHECK (
    btrim(body_text) = body_text AND length(body_text) BETWEEN 1 AND 1024
  ),
  -- How many ordered {{n}} parameters the body takes. Stored rather than
  -- re-counted at send time because it is what a caller is checked
  -- against, and a regular expression run over a template body on every
  -- send is a rule that lives in whichever language happens to be calling.
  parameter_count integer NOT NULL DEFAULT 0
    CHECK (parameter_count BETWEEN 0 AND 20),

  email_subject text CHECK (
    email_subject IS NULL
    OR (btrim(email_subject) = email_subject AND length(email_subject) BETWEEN 1 AND 200)
  ),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, name, language),

  -- Meta only ever gives a reason when it has done something to the
  -- template. A draft carrying a rejection reason is a row that has
  -- confused a note to self with a decision by the reviewer.
  CONSTRAINT notification_templates_status_reason_shape CHECK (
    status_reason IS NULL OR status IN ('rejected', 'paused', 'disabled')
  )
);

COMMENT ON TABLE notification_templates IS
  'What the organisation is allowed to say. The status column is Meta''s template lifecycle, recorded by a member reading the Meta console rather than polled — the WABA that would answer a poll is still in onboarding, and the column already means the right thing for the day it exists.';
COMMENT ON COLUMN notification_templates.parameter_count IS
  'How many ordered {{n}} placeholders body_text takes. Stored so the send path checks a number rather than re-parsing prose, and so the same count is enforced by the database and by the route.';
COMMENT ON COLUMN notification_templates.email_subject IS
  'Present exactly when this template may go out by email. WhatsApp has no subject line, so its absence is what makes a template WhatsApp-only rather than a missing field.';

CREATE INDEX notification_templates_register_idx
  ON notification_templates (organisation_id, name, language);

ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_templates_tenant_policy ON notification_templates
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. Every message in the log names the template it was rendered
-- from, and a delivery log whose rows point at a template nobody can read
-- is a log that cannot answer what was sent. A template that is no longer
-- used is `disabled`.
GRANT SELECT, INSERT, UPDATE ON notification_templates TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 3. The consent register.
--
-- One current state per contact per channel, plus the evidence sentence
-- the member wrote when they recorded it. The HISTORY of the state is
-- audit_events (0002), which already records every change with actor and
-- timestamp; a second history table here would be the same rows in a
-- second place, which is the "two things that can disagree" this schema
-- avoids everywhere else.
--
-- `address` is the load-bearing column and the header explains why: an
-- agreement was given for a number, not for a person, and the number
-- outlives the officer who consented.
-- ---------------------------------------------------------------------
CREATE TABLE notification_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  contact_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),

  -- E.164 for WhatsApp, an address for email. Snapshotted rather than
  -- read through to `contacts`, because it is the thing consented to.
  address text NOT NULL CHECK (
    btrim(address) = address AND length(address) BETWEEN 3 AND 200
  ),

  state text NOT NULL CHECK (state IN ('opted_in', 'opted_out')),

  -- How the agreement was obtained, in the member's own words: "signed
  -- the delivery acknowledgement", "asked on the site call of 12 Aug".
  -- Required, and required even for an opt-out, where it records who
  -- asked to stop being messaged.
  evidence text NOT NULL CHECK (
    btrim(evidence) = evidence AND length(evidence) BETWEEN 3 AND 500
  ),

  recorded_by_user_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, contact_id, channel),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES contacts (organisation_id, id),

  -- The address has to be the shape the channel can actually reach.
  CONSTRAINT notification_consents_address_shape CHECK (
    CASE channel
      WHEN 'whatsapp' THEN address ~ '^\+[1-9][0-9]{7,14}$'
      WHEN 'email' THEN position('@' in address) > 1
      ELSE false
    END
  )
);

COMMENT ON TABLE notification_consents IS
  'Who has agreed to be messaged, per channel, at which address. Consent is per ADDRESS: a railway office mobile is reassigned when the officer transfers, and an agreement recorded against the person would carry silently across to whoever now holds the number.';
COMMENT ON COLUMN notification_consents.evidence IS
  'How the agreement was obtained, in the recording member''s own words. Required for an opt-out too, where it records who asked to stop.';

-- The leading index the composite foreign key needs.
CREATE INDEX notification_consents_contact_idx
  ON notification_consents (organisation_id, contact_id);
-- The register, and the lookup the send guard makes.
CREATE INDEX notification_consents_register_idx
  ON notification_consents (organisation_id, channel, address);

ALTER TABLE notification_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_consents FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_consents_tenant_policy ON notification_consents
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. "We never had their consent" and "we had it and deleted the
-- record" are the same row absent, and only one of them is a defence.
-- Withdrawal is `opted_out`, which keeps the evidence of both the
-- agreement and its end.
GRANT SELECT, INSERT, UPDATE ON notification_consents TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. The delivery log.
--
-- One row per message, written before the provider is called and
-- completed after it.
--
-- WHAT IT STORES OF THE MESSAGE, AND WHY IT IS NOT THE MESSAGE. The row
-- holds the template it was rendered from and the ordered parameter
-- values, not the rendered text. The text is reproducible from the two,
-- the two are what a dispute is actually about ("which template, with
-- whose name in it"), and one less copy of a rendered body is one less
-- place for personal data to sit. `to_address` IS stored, because a
-- delivery log that cannot say who a message went to answers nothing.
--
-- AGENTS.md rule 11 covers the other half of this: none of these values
-- reaches a log line. The route logs the message id and the outcome.
-- ---------------------------------------------------------------------
CREATE TABLE notification_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  template_id uuid NOT NULL,
  contact_id uuid NOT NULL,

  -- Snapshotted at send time. The consent that permitted this send was
  -- for THIS address, and the guard below proves the two agree.
  to_address text NOT NULL CHECK (
    btrim(to_address) = to_address AND length(to_address) BETWEEN 3 AND 200
  ),
  -- The ordered {{1}}..{{n}} values, as a JSON array of strings.
  parameters jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(parameters) = 'array'),

  -- Which transport actually carried it. Recorded per message rather than
  -- read from the channel row, because the channel row is editable and
  -- this is history: an organisation that moves from Meta direct to a BSP
  -- must still be able to say which of its old messages went which way.
  provider text NOT NULL CHECK (provider IN ('meta_cloud', 'bsp', 'smtp')),
  provider_message_id text CHECK (
    provider_message_id IS NULL
    OR (btrim(provider_message_id) = provider_message_id
        AND length(provider_message_id) BETWEEN 1 AND 200)
  ),

  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'sent', 'delivered', 'read', 'failed')
  ),

  -- A short symbolic code from the provider and a short human line. Never
  -- the provider's raw body: a WhatsApp error payload echoes the
  -- recipient's number back, and this column is exported.
  failure_code text CHECK (
    failure_code IS NULL OR failure_code ~ '^[A-Za-z0-9_.:-]{1,64}$'
  ),
  failure_detail text CHECK (
    failure_detail IS NULL
    OR (btrim(failure_detail) = failure_detail
        AND length(failure_detail) BETWEEN 1 AND 500)
  ),

  requested_by_user_id text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, template_id)
    REFERENCES notification_templates (organisation_id, id),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES contacts (organisation_id, id),

  -- Each state carries exactly the facts it is allowed to have. A
  -- `delivered` row that never recorded being sent is a row whose ledger
  -- lost a step, and the register would draw it as though nothing was
  -- wrong.
  CONSTRAINT notification_messages_outcome_shape CHECK (
    CASE status
      WHEN 'queued' THEN
        provider_message_id IS NULL AND sent_at IS NULL AND delivered_at IS NULL
        AND read_at IS NULL AND failed_at IS NULL AND failure_code IS NULL
      WHEN 'sent' THEN
        sent_at IS NOT NULL AND delivered_at IS NULL AND read_at IS NULL
        AND failed_at IS NULL AND failure_code IS NULL
      WHEN 'delivered' THEN
        sent_at IS NOT NULL AND delivered_at IS NOT NULL AND read_at IS NULL
        AND failed_at IS NULL AND failure_code IS NULL
      WHEN 'read' THEN
        sent_at IS NOT NULL AND delivered_at IS NOT NULL AND read_at IS NOT NULL
        AND failed_at IS NULL AND failure_code IS NULL
      WHEN 'failed' THEN
        failed_at IS NOT NULL AND failure_code IS NOT NULL
        AND delivered_at IS NULL AND read_at IS NULL
      ELSE false
    END
  )
);

COMMENT ON TABLE notification_messages IS
  'Every message the organisation sent, and what became of it. Written before the provider is called and completed after it, so a process that dies mid-send leaves evidence that it called. Holds the template and its parameters rather than the rendered text: the text is reproducible from the two, and one less copy of a rendered body is one less place personal data sits.';
COMMENT ON COLUMN notification_messages.provider IS
  'Which transport actually carried this message, recorded per row rather than read from the editable channel configuration — an organisation that moves from Meta direct to a BSP must still be able to say which of its old messages went which way.';
COMMENT ON COLUMN notification_messages.failure_code IS
  'The provider''s symbolic error code and nothing else. Never its raw response body: a WhatsApp error payload echoes the recipient number back, and this column is exported.';

-- GLOBALLY unique per provider message id, partial because a queued row
-- has none. Meta's receipts name a message by this id, and
-- app_private.record_notification_receipt resolves it BEFORE any tenant
-- is bound, so it has to name one row in the cluster.
CREATE UNIQUE INDEX notification_messages_provider_message_id_key
  ON notification_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- The leading indexes the composite foreign keys need, non-partial: a
-- referential-integrity check cannot use a partial index
-- (test/fk-index-coverage.integration.test.ts).
CREATE INDEX notification_messages_template_idx
  ON notification_messages (organisation_id, template_id);
CREATE INDEX notification_messages_contact_idx
  ON notification_messages (organisation_id, contact_id);

-- The delivery-log register: newest first, keyset-seekable. `queued_at`
-- alone ties whenever a batch goes out in one call, so the id closes the
-- key and gives the seek a total order.
CREATE INDEX notification_messages_register_idx
  ON notification_messages (organisation_id, queued_at DESC, id DESC);

ALTER TABLE notification_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_messages_tenant_policy ON notification_messages
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. The log is the answer to "did you tell us", and a log whose
-- inconvenient rows can be removed is not evidence of anything.
GRANT SELECT, INSERT, UPDATE ON notification_messages TO auto_mb_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_definer') THEN
    GRANT SELECT, UPDATE ON notification_messages TO auto_mb_definer;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 5. Applying a webhook receipt, before any tenant exists.
--
-- The chicken and egg every inbound callback has, and NOT the same one
-- 0091's `resolve_signing_agent` solves. The kiosk authenticates as a
-- member and everything it does afterwards runs on that member's
-- authority. Meta is not a member of anything: a delivery receipt is a
-- fact from outside the organisation, arriving on a public address, with
-- nobody's authority behind it.
--
-- The two candidates, and why this is the one:
--
--   Bind as the member who configured the channel. Rejected. It invents
--   an actor who did not act, and it couples the receipt path to that
--   person's membership — the day they leave, delivery receipts stop
--   arriving and nothing says why.
--
--   One SECURITY DEFINER function that applies exactly one receipt.
--   Taken. AGENTS.md wants a definer function argued rather than assumed,
--   so: it is the narrowest surface that can do the job. It takes a phone
--   number id and a provider message id, updates at most one row, and
--   returns whether it matched. There is no predicate a caller can widen,
--   nothing about the message comes back, and the provider message id is
--   an unguessable value minted by Meta — so this is not an enumeration
--   oracle. The phone number id is required as well as the message id so
--   that a receipt can only ever move a row belonging to the organisation
--   that owns the number it arrived on.
--
-- The row's own guard still runs: this function writes through
-- `notification_messages_guard` like every other writer, so the
-- monotonicity rule below holds against Meta exactly as it holds against
-- the application.
--
-- OUT-OF-ORDER RECEIPTS ARE A NO-OP, NOT A REFUSAL. Meta re-delivers, and
-- `delivered` arriving after `read` is routine. The WHERE clause admits
-- only a forward move, so a late receipt updates nothing and the function
-- answers false — the receiver then still answers Meta 200, because a
-- non-200 makes Meta retry a receipt that was already applied.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.record_notification_receipt(
  p_phone_number_id text,
  p_provider_message_id text,
  p_status text,
  p_occurred_at timestamptz,
  p_failure_code text,
  p_failure_detail text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $$
DECLARE
  v_organisation_id uuid;
  v_updated integer;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RETURN false;
  END IF;

  SELECT c.organisation_id INTO v_organisation_id
  FROM notification_channels c
  WHERE c.waba_phone_number_id = p_phone_number_id;

  IF v_organisation_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE notification_messages m
  SET status = p_status,
      -- A failure never invents a send. Every other forward state implies
      -- one, so a `delivered` that overtook its own `sent` fills the gap
      -- with the instant it can actually prove.
      sent_at = CASE
        WHEN p_status = 'failed' THEN m.sent_at
        ELSE coalesce(m.sent_at, p_occurred_at)
      END,
      delivered_at = CASE
        WHEN p_status IN ('delivered', 'read') THEN coalesce(m.delivered_at, p_occurred_at)
        ELSE m.delivered_at
      END,
      read_at = CASE
        WHEN p_status = 'read' THEN coalesce(m.read_at, p_occurred_at)
        ELSE m.read_at
      END,
      failed_at = CASE WHEN p_status = 'failed' THEN p_occurred_at ELSE m.failed_at END,
      -- The outcome CHECK requires a code on every failure, and Meta does
      -- not always send one. `unspecified` is the honest value: it says a
      -- failure was reported and the provider named nothing, which is a
      -- different fact from the column being empty because nobody looked.
      failure_code = CASE
        WHEN p_status = 'failed' THEN coalesce(p_failure_code, 'unspecified')
        ELSE m.failure_code
      END,
      failure_detail =
        CASE WHEN p_status = 'failed' THEN p_failure_detail ELSE m.failure_detail END
  WHERE m.organisation_id = v_organisation_id
    AND m.provider_message_id = p_provider_message_id
    -- Forward only. The ordering is the ledger's own:
    -- queued < sent < delivered < read, and failed is terminal from
    -- either queued or sent.
    AND CASE p_status
      WHEN 'sent' THEN m.status = 'queued'
      WHEN 'delivered' THEN m.status IN ('queued', 'sent')
      WHEN 'read' THEN m.status IN ('queued', 'sent', 'delivered')
      WHEN 'failed' THEN m.status IN ('queued', 'sent')
      ELSE false
    END;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END
$$;

ALTER FUNCTION app_private.record_notification_receipt(
  text, text, text, timestamptz, text, text
) OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.record_notification_receipt(
  text, text, text, timestamptz, text, text
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.record_notification_receipt(
      text, text, text, timestamptz, text, text
    ) TO auto_mb_app;
  END IF;
END
$$;

COMMENT ON FUNCTION app_private.record_notification_receipt(
  text, text, text, timestamptz, text, text
) IS
  'The one write that crosses tenancy for the notifications lane: a webhook receipt from Meta, applied to at most one message row, forward only. Meta is not a member of anything, so there is no member to bind as; this is the narrowest surface that can record the fact. Returns whether a row moved — a late or duplicate receipt moves nothing and is not an error.';

-- ---------------------------------------------------------------------
-- 6. The write guards.
--
-- Every rule below is also checked by the route, first, under no lock, so
-- an operator gets a named 409 with a remedy. These are the arm that holds
-- when a writer reaches the table another way, and the arm that holds
-- under concurrency, which the route cannot.
--
-- SQLSTATEs come from the 23K block, one per rule. (`I` is skipped in this
-- schema's block allocation: `23I0…` reads as a digit at a glance, and the
-- one thing an operator does with a SQLSTATE is read it aloud.)
--
-- `SET search_path` for the reason 0067, 0077, 0079, 0084, 0087 and 0091
-- all give: a function that resolves its own identifiers through the
-- caller's path is a rule a shadowing object in a writable schema can
-- rewrite into whatever it likes. Not SECURITY DEFINER: every table
-- touched is one the caller may already read under RLS.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_notification_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A complete configuration is what `enabled` is allowed to switch on.
  -- The shape CHECKs say which columns belong to which channel; this says
  -- which of them must actually be there before anything is sent.
  IF NEW.enabled THEN
    IF NEW.channel = 'whatsapp' AND (
         NEW.waba_phone_number_id IS NULL
         OR NEW.waba_business_account_id IS NULL
         OR NEW.display_phone_number IS NULL
       ) THEN
      RAISE EXCEPTION
        'the WhatsApp channel needs its phone number id, business account id and display number before it can be enabled'
        USING ERRCODE = '23K02';
    END IF;
    IF NEW.channel = 'email' AND NEW.from_address IS NULL THEN
      RAISE EXCEPTION 'the email channel needs a sender address before it can be enabled'
        USING ERRCODE = '23K02';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Which organisation, and which channel, are written once. Everything
  -- else about a channel is configuration an operator revises as Meta
  -- onboarding progresses.
  IF ROW(NEW.id, NEW.organisation_id, NEW.channel, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.channel, OLD.created_at) THEN
    RAISE EXCEPTION
      'a notification channel''s identity is written once; configure the other channel instead'
      USING ERRCODE = '23K01';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_notification_channel() IS
  'A channel is enabled only once its own configuration is complete, and its identity — which organisation, which channel — is written once. The route refuses first so an operator gets a remedy; this is the arm that holds under concurrency.';

CREATE TRIGGER notification_channels_guard
BEFORE INSERT OR UPDATE ON notification_channels
FOR EACH ROW EXECUTE FUNCTION app_private.guard_notification_channel();

CREATE FUNCTION app_private.guard_notification_template()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A template arrives as a draft. Recording one as already approved
    -- would be recording a Meta decision that was never made.
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a notification template is created as a draft, not as %', NEW.status
        USING ERRCODE = '23K03';
    END IF;
    RETURN NEW;
  END IF;

  -- The identity Meta knows the template by, and the body it reviewed.
  -- Editing an approved body would leave the WABA holding one text and
  -- this register showing another — and the WABA's is what is sent.
  IF ROW(NEW.id, NEW.organisation_id, NEW.name, NEW.language, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.name, OLD.language, OLD.created_at)
  THEN
    RAISE EXCEPTION
      'a notification template''s name and language are what Meta knows it by and are written once; create a new template'
      USING ERRCODE = '23K03';
  END IF;

  IF OLD.status <> 'draft'
     AND ROW(NEW.body_text, NEW.parameter_count, NEW.category)
         IS DISTINCT FROM ROW(OLD.body_text, OLD.parameter_count, OLD.category) THEN
    RAISE EXCEPTION
      'the body of a submitted template cannot be edited: Meta holds the reviewed text, and it is that text which is sent'
      USING ERRCODE = '23K03';
  END IF;

  -- Meta's lifecycle, stated once:
  --
  --   draft    -> pending
  --   pending  -> approved | rejected
  --   approved -> paused | disabled
  --   paused   -> approved | disabled
  --   rejected -> pending   (resubmitted after the body was… no: see below)
  --   disabled -> (terminal)
  --
  -- A rejected template does NOT return to pending here, and that is
  -- deliberate rather than an omission: Meta rejects a body, the body is
  -- frozen once submitted, and a resubmission is therefore a different
  -- template. Letting a rejected row go back to pending would produce a
  -- row claiming review of a text nobody changed.
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status = 'pending')
      OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
      OR (OLD.status = 'approved' AND NEW.status IN ('paused', 'disabled'))
      OR (OLD.status = 'paused' AND NEW.status IN ('approved', 'disabled'))
    ) THEN
      RAISE EXCEPTION 'a notification template cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = '23K03';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_notification_template() IS
  'A template is created as a draft, its name and language are what Meta knows it by, its body freezes the moment it is submitted, and its status walks Meta''s own lifecycle forwards. A rejected template is not resubmitted: the body it was rejected for cannot change, so a resubmission is a different template.';

CREATE TRIGGER notification_templates_guard
BEFORE INSERT OR UPDATE ON notification_templates
FOR EACH ROW EXECUTE FUNCTION app_private.guard_notification_template();

CREATE FUNCTION app_private.guard_notification_consent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Which contact, and which channel, are what this row IS. Re-pointing
  -- either would move an agreement one person gave onto another, which is
  -- the exact failure the per-address rule exists to prevent.
  IF ROW(NEW.id, NEW.organisation_id, NEW.contact_id, NEW.channel, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organisation_id, OLD.contact_id, OLD.channel, OLD.recorded_at) THEN
    RAISE EXCEPTION
      'a consent record names one contact on one channel and that is written once'
      USING ERRCODE = '23K04';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_notification_consent() IS
  'Which contact and which channel a consent is about are written once. The state, the address and the evidence are revised — an agreement given for a new number is a new agreement, recorded on the same row with its own evidence sentence.';

CREATE TRIGGER notification_consents_guard
BEFORE INSERT OR UPDATE ON notification_consents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_notification_consent();

CREATE FUNCTION app_private.guard_notification_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_template notification_templates%ROWTYPE;
  v_consent notification_consents%ROWTYPE;
  v_channel_enabled boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.enabled INTO v_channel_enabled
    FROM notification_channels c
    WHERE c.organisation_id = NEW.organisation_id AND c.channel = NEW.channel;

    IF v_channel_enabled IS NULL OR NOT v_channel_enabled THEN
      RAISE EXCEPTION 'the % channel is not configured and enabled for this organisation', NEW.channel
        USING ERRCODE = '23K05';
    END IF;

    SELECT * INTO v_template
    FROM notification_templates t
    WHERE t.organisation_id = NEW.organisation_id AND t.id = NEW.template_id;

    IF v_template.id IS NULL THEN
      RAISE EXCEPTION 'notification template % does not exist', NEW.template_id
        USING ERRCODE = '23K06';
    END IF;

    -- The two sendability rules, and neither gates the other: WhatsApp
    -- needs Meta's approval, email needs a subject line. An organisation
    -- with no WABA can still send email.
    IF NEW.channel = 'whatsapp' AND v_template.status <> 'approved' THEN
      RAISE EXCEPTION
        'template %/% is % at Meta, and only an approved template may be sent over WhatsApp',
        v_template.name, v_template.language, v_template.status
        USING ERRCODE = '23K06';
    END IF;

    IF NEW.channel = 'email' AND v_template.email_subject IS NULL THEN
      RAISE EXCEPTION 'template %/% has no subject line, so it cannot be sent by email',
        v_template.name, v_template.language
        USING ERRCODE = '23K06';
    END IF;

    IF jsonb_array_length(NEW.parameters) <> v_template.parameter_count THEN
      RAISE EXCEPTION 'template %/% takes % parameters and was given %',
        v_template.name, v_template.language, v_template.parameter_count,
        jsonb_array_length(NEW.parameters)
        USING ERRCODE = '23K06';
    END IF;

    -- The consent, and it has to be for THIS address. A contact who
    -- opted in on one number has not opted in on another.
    SELECT * INTO v_consent
    FROM notification_consents n
    WHERE n.organisation_id = NEW.organisation_id
      AND n.contact_id = NEW.contact_id
      AND n.channel = NEW.channel;

    IF v_consent.id IS NULL OR v_consent.state <> 'opted_in'
       OR v_consent.address <> NEW.to_address THEN
      RAISE EXCEPTION
        'no recorded opt-in for this contact on % at the address the message is addressed to',
        NEW.channel
        USING ERRCODE = '23K07';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE from here down.

  -- What was sent, to whom, through what, is written once. A delivery log
  -- whose subject can be edited after the fact records nothing.
  IF ROW(
       NEW.id, NEW.organisation_id, NEW.channel, NEW.template_id, NEW.contact_id,
       NEW.to_address, NEW.parameters, NEW.provider, NEW.requested_by_user_id,
       NEW.queued_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.organisation_id, OLD.channel, OLD.template_id, OLD.contact_id,
       OLD.to_address, OLD.parameters, OLD.provider, OLD.requested_by_user_id,
       OLD.queued_at
     ) THEN
    RAISE EXCEPTION 'the sent facts of a notification are written once'
      USING ERRCODE = '23K08';
  END IF;

  -- Forward only, and the same ordering
  -- `app_private.record_notification_receipt` filters on. Stated in both
  -- places on purpose: the function's WHERE clause makes a late receipt a
  -- silent no-op, and this makes any OTHER writer's attempt a named
  -- refusal rather than a quietly rewound ledger.
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'queued' AND NEW.status IN ('sent', 'delivered', 'read', 'failed'))
      OR (OLD.status = 'sent' AND NEW.status IN ('delivered', 'read', 'failed'))
      OR (OLD.status = 'delivered' AND NEW.status = 'read')
    ) THEN
      RAISE EXCEPTION 'a notification cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = '23K09';
    END IF;
  END IF;

  -- A provider names a message once. Rewriting the id would re-point
  -- every future receipt at a row it is not about.
  IF OLD.provider_message_id IS NOT NULL
     AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'the provider''s own message id is recorded once'
      USING ERRCODE = '23K08';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_notification_message() IS
  'Everything a notification is allowed to be: sent only through an enabled channel, only from a template that channel may carry, only with the parameter count that template takes, and only to an address the contact recorded an opt-in for. Afterwards the sent facts are frozen and the delivery status walks forwards only.';

CREATE TRIGGER notification_messages_guard
BEFORE INSERT OR UPDATE ON notification_messages
FOR EACH ROW EXECUTE FUNCTION app_private.guard_notification_message();
