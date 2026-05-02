USE Belissima_Database;

CREATE TABLE IF NOT EXISTS ProviderPhotos (
    `photoID`       INT NOT NULL AUTO_INCREMENT,
    `businessID`    VARCHAR(25) NOT NULL,
    `photo_url`     VARCHAR(2048) NOT NULL,
    `is_primary`    TINYINT(1) DEFAULT 0,
    `sort_order`    INT DEFAULT 0,
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (photoID),
    FOREIGN KEY (businessID) REFERENCES Providers(businessID) ON DELETE CASCADE
);