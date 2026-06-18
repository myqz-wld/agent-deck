ALTER TABLE issues ADD COLUMN branch_name TEXT CHECK(branch_name IS NULL OR length(branch_name) <= 255);
