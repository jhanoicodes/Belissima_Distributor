USE Belissima_Database;

CREATE TABLE IF NOT EXISTS ProviderRequests(
    requestID INT NOT NULL AUTO_INCREMENT,

    -- Contact and Business Details
    `email`   VARCHAR(150) NOT NULL,
    `business_name`   VARCHAR(255) NOT NULL,
    `service_type`  ENUM ('NAIL ARTIST', 'MAKEUP ARTIST', 'HAIRDRESSER','WAXER') NOT NULL,
    `parish`    ENUM('Kingston', 'Portmore') NOT NULL, 
    `phone_number`    VARCHAR(30) NOT NULL,
    `other_contact` VARCHAR(50) NULL,
    `address`   VARCHAR(255) NULL,  

    -- Social Media Links and Booking Links
    `insta_link`    VARCHAR(2048) NULL,
    `tiktok_link`   VARCHAR(2048) NULL,
    `facebook_link` VARCHAR(2048) NULL,
    `booking_link`  VARCHAR(2048) NULL,
    `other_booking` VARCHAR(50) NULL,

    -- Pricing and Timing
    `starting_price`    DECIMAL(10,2) NULL,
    `average_worktime`  INT NULL COMMENT 'in minutes',

    -- Provider Attributes
    `provider_gender`   ENUM('female', 'male') NULL,
    `board_certified`   TINYINT(1) NULL,
    `company_allowed`   TINYINT(1) NULL,
    `walkins_allowed`   TINYINT(1) NULL,
    `mobile_service`    TINYINT(1) NULL,
    `kid_friendly`      TINYINT(1) NULL,
    `disabled_friendly` TINYINT(1) NULL,      

    -- Payment and Deposit
    `payment_methods`   JSON NULL,
    `deposit_required`  TINYINT(1) NULL,
    `deposit_type`  ENUM('fixed','percentage') NULL,
    `deposit_value` DECIMAL(10,2) NULL,

    -- Opening Hours
    `opening_hours` JSON NULL,
    `days_open`     TINYINT NULL,
    `weekly_hours`  DECIMAL(5,1) NULL,
    
    -- Extra Notes from Applicant
    `extra_notes`   TEXT NULL,

    -- Admin Review
    `status`    ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    `admin_notes`   TEXT NULL COMMENT 'Internal notes from admin during review',
    `reviewed_by`   VARCHAR(100) NULL COMMENT 'Name or email of admin who reviewed',
    `reviewed_at`   DATETIME NULL,

    -- Timestamps
    `submitted_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY(requestID),
    INDEX idx_status(status),
    INDEX idx_email(email),
    INDEX idx_service(service_type),
    INDEX idx_parish(parish)
    
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;