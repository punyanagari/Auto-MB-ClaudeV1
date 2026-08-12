SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- NIC's Loc fields are statutory facts. They must not be guessed from a
-- free-text address when an invoice is registered. Existing rows remain NULL;
-- operators explicitly confirm locality before issuing a new IRP-ready invoice.
ALTER TABLE organisations
  ADD COLUMN locality text
    CHECK (locality IS NULL OR length(btrim(locality)) BETWEEN 2 AND 100);

ALTER TABLE contacts
  ADD COLUMN locality text
    CHECK (locality IS NULL OR length(btrim(locality)) BETWEEN 2 AND 100);

COMMENT ON COLUMN organisations.locality IS
  'Explicit locality printed in NIC SellerDtls.Loc; never inferred from address.';
COMMENT ON COLUMN contacts.locality IS
  'Explicit locality printed in NIC BuyerDtls/ShipDtls.Loc; never inferred from address.';
