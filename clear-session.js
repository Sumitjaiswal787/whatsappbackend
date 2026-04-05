const fs = require('fs');
const path = require('path');

const DIRECTORIES_TO_CLEAR = [
    path.join(__dirname, '.wwebjs_auth'),
    path.join(__dirname, '.wwebjs_cache')
];

function clearDirectories() {
    console.log('--- Cleaning up WhatsApp Web Sessions ---');
    DIRECTORIES_TO_CLEAR.forEach(dir => {
        if (fs.existsSync(dir)) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                console.log(`CLEARED: ${dir}`);
            } catch (err) {
                console.error(`ERROR clearing ${dir}:`, err.message);
            }
        } else {
            console.log(`NOT FOUND: ${dir} (Skipping)`);
        }
    });
    console.log('Cleanup complete. Ready for a fresh start.');
}

clearDirectories();
