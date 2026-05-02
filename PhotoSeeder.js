require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

const data = JSON.parse(fs.readFileSync('./ProviderPhotos.json', 'utf-8'));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'Belissima_Database',
  waitForConnections: true,
  connectionLimit: 5,
});

async function seedPhotos() {
  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  try {
    // First verify the table exists
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ProviderPhotos (
        photoID     INT NOT NULL AUTO_INCREMENT,
        businessID  VARCHAR(25) NOT NULL,
        photo_url   VARCHAR(2048) NOT NULL,
        is_primary  TINYINT(1) DEFAULT 0,
        sort_order  INT DEFAULT 0,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (photoID),
        FOREIGN KEY (businessID) REFERENCES Providers(businessID) ON DELETE CASCADE
      )
    `);
    console.log("✅ ProviderPhotos table ready");

    for (const provider of data) {
      const bid = provider.businessID;

      // Check the provider actually exists in DB before trying to insert
      const [exists] = await pool.execute(
        `SELECT businessID FROM Providers WHERE businessID = ?`,
        [bid]
      );

      if (exists.length === 0) {
        console.warn(`⚠️  Skipping ${bid} — not found in Providers table`);
        skipped++;
        continue;
      }

      // Delete old photos for this provider
      await pool.execute(
        `DELETE FROM ProviderPhotos WHERE businessID = ?`,
        [bid]
      );

      // Insert fresh photos
      for (const photo of provider.photos) {
        await pool.execute(
          `INSERT INTO ProviderPhotos (businessID, photo_url, is_primary, sort_order)
           VALUES (?, ?, ?, ?)`,
          [bid, photo.url, photo.is_primary, photo.sort_order]
        );
      }

      console.log(`✅ Seeded ${bid} — ${provider.photos.length} photo(s)`);
      seeded++;
    }

  } catch (err) {
    console.error("❌ Seeder failed:", err.message);
    failed++;
  } finally {
    await pool.end();
    console.log(`\n📊 Done — Seeded: ${seeded} | Skipped: ${skipped} | Failed: ${failed}`);
  }
}

seedPhotos();