CREATE DATABASE IF NOT EXISTS kyc_system;
USE kyc_system;

CREATE TABLE service_providers (
    service_provider_id INT PRIMARY KEY,
    service_provider_name VARCHAR(100) NOT NULL
);

CREATE TABLE clients (
    client_id INT PRIMARY KEY,
    client_name VARCHAR(100) NOT NULL,
    mapped_service_provider_id INT,
    CONSTRAINT fk_provider
        FOREIGN KEY (mapped_service_provider_id)
        REFERENCES service_providers(service_provider_id)
);

INSERT INTO service_providers VALUES
(1, 'Global KYC Ltd'),
(2, 'VeriCheck Partners'),
(3, 'Identity Secure Inc');

INSERT INTO clients VALUES
(101, 'Acme Corp', 2),
(102, 'Beta Industries', 2),
(103, 'Gamma LLC', 1);
