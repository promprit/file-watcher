-- Initial database schema for setup verification
-- Creates a simple table to verify database initialization works

CREATE TABLE IF NOT EXISTS interface_table (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert test data for verification
INSERT INTO interface_table (name) VALUES ('Setup Verification Test');

-- Verify table was created
SELECT 'interface_table created successfully' AS status;
