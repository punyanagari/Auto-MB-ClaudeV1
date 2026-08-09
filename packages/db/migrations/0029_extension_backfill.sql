SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 6/7 retrofit (Track 2): manual back-fill of DOC extension
-- letters (legacy spec §5.5). Paper letters issued before the software
-- was adopted enter the register as FINALISED-ON-ARRIVAL records: they
-- take the paper letter's reference and letter date, occupy the next
-- <work_code>-Extension-NN slot immediately (same counter discipline as a
-- software finalisation), and are deletable ONLY from the top of the
-- sequence and only by an amendment-approval holder — the sequence never
-- gains a gap. Software-generated finalised letters remain permanently
-- undeletable, exactly as 0011 promised.

-- 1. Source marking. 'software' is every pre-existing row (drafted and
-- finalised in the product); 'manual' is a back-filled paper letter,
-- which always carries the paper reference and is never a draft.
ALTER TABLE extension_requests
  ADD COLUMN source text NOT NULL DEFAULT 'software'
    CHECK (source IN ('software', 'manual')),
  ADD COLUMN manual_reference text
    CHECK (manual_reference IS NULL OR length(btrim(manual_reference)) BETWEEN 1 AND 100);

ALTER TABLE extension_requests
  ADD CONSTRAINT extension_requests_manual_pairing_check
  CHECK ((source = 'manual') = (manual_reference IS NOT NULL));

ALTER TABLE extension_requests
  ADD CONSTRAINT extension_requests_manual_never_draft_check
  CHECK (source <> 'manual' OR status <> 'draft');

-- 2. The counter may roll back to 0: deleting the top-of-sequence manual
-- record where sequence_number = 1 reopens the very first slot. The
-- finalise upsert (ON CONFLICT DO UPDATE next_value = next_value + 1)
-- then hands out 1 again, so gaplessness is preserved through zero.
ALTER TABLE extension_request_counters
  DROP CONSTRAINT extension_request_counters_next_value_check;
ALTER TABLE extension_request_counters
  ADD CONSTRAINT extension_request_counters_next_value_check
  CHECK (next_value >= 0);

-- 3. The delete guard, extended. Deletion rules by state:
--   draft                      -> deletable (unchanged since 0011);
--   manual + finalised         -> deletable ONLY while it holds the top
--                                 of the sequence. The proof is the
--                                 counter itself: the decrement matches
--                                 only when next_value still equals this
--                                 row's sequence_number, and the counter
--                                 row lock serialises the decrement
--                                 against concurrent finalisations, so a
--                                 delete can never open a gap under a
--                                 racing finalise;
--   manual + responded         -> refused: the railway's answer (and a
--                                 possibly moved completion date) hangs
--                                 off it — it is part of the ledger;
--   software + finalised/responded -> never deletable.
-- Runs as the invoking role: the counter UPDATE goes through the caller's
-- own RLS and UPDATE grant, like every guarded numbering path.
CREATE OR REPLACE FUNCTION app_private.guard_extension_request_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN OLD;
  END IF;

  IF OLD.source = 'manual' AND OLD.status = 'finalised' THEN
    UPDATE extension_request_counters
    SET next_value = next_value - 1
    WHERE organisation_id = OLD.organisation_id
      AND work_id = OLD.work_id
      AND next_value = OLD.sequence_number;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'only the top-of-sequence manual back-fill may be deleted (extension numbers never gain gaps)';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.source = 'manual' THEN
    RAISE EXCEPTION 'a responded manual back-fill anchors the completion-date record and cannot be deleted';
  END IF;

  RAISE EXCEPTION 'finalised software-generated extension letters can never be deleted';
END
$$;

-- 4. The immutability guard learns the two new columns: source and the
-- paper reference are business identity and freeze at finalisation with
-- everything else (0011 left them out because they did not exist).
CREATE OR REPLACE FUNCTION app_private.guard_extension_request_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'responded' THEN
    IF NEW.status <> 'responded' THEN
      RAISE EXCEPTION 'extension request status only moves forward: draft -> finalised -> responded';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.proposed_completion_date, NEW.reason,
      NEW.addressee, NEW.letter_date, NEW.sequence_number, NEW.request_number,
      NEW.finalised_snapshot, NEW.template_version, NEW.response_object_key,
      NEW.response_sha256, NEW.response_outcome, NEW.granted_completion_date,
      NEW.created_by_user_id, NEW.finalised_by_user_id, NEW.responded_by_user_id,
      NEW.created_at, NEW.finalised_at, NEW.responded_at,
      NEW.source, NEW.manual_reference
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.proposed_completion_date, OLD.reason,
      OLD.addressee, OLD.letter_date, OLD.sequence_number, OLD.request_number,
      OLD.finalised_snapshot, OLD.template_version, OLD.response_object_key,
      OLD.response_sha256, OLD.response_outcome, OLD.granted_completion_date,
      OLD.created_by_user_id, OLD.finalised_by_user_id, OLD.responded_by_user_id,
      OLD.created_at, OLD.finalised_at, OLD.responded_at,
      OLD.source, OLD.manual_reference
    ) THEN
      RAISE EXCEPTION 'responded extension requests are immutable apart from re-rendering the letter';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'finalised' THEN
    IF NEW.status NOT IN ('finalised', 'responded') THEN
      RAISE EXCEPTION 'finalised extension requests may only remain finalised or become responded';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.proposed_completion_date, NEW.reason,
      NEW.addressee, NEW.letter_date, NEW.sequence_number, NEW.request_number,
      NEW.finalised_snapshot, NEW.template_version, NEW.created_by_user_id,
      NEW.finalised_by_user_id, NEW.created_at, NEW.finalised_at,
      NEW.source, NEW.manual_reference
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.proposed_completion_date, OLD.reason,
      OLD.addressee, OLD.letter_date, OLD.sequence_number, OLD.request_number,
      OLD.finalised_snapshot, OLD.template_version, OLD.created_by_user_id,
      OLD.finalised_by_user_id, OLD.created_at, OLD.finalised_at,
      OLD.source, OLD.manual_reference
    ) THEN
      RAISE EXCEPTION 'finalised extension request business data is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'responded' THEN
    RAISE EXCEPTION 'a draft extension request must be finalised before a response is recorded';
  END IF;

  RETURN NEW;
END
$$;
