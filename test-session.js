const axios = require('axios');

const TEST_CONFIG = {
    url: 'http://localhost:3001/session/init',
    data: {
        sessionId: 'test_session_' + Date.now(),
        userId: '1',
        phoneNumber: 'mock' // Use 'mock' to bypass real WhatsApp login
    }
};

async function testSessionInit() {
    console.log('Sending test initialization request...');
    try {
        const response = await axios.post(TEST_CONFIG.url, TEST_CONFIG.data);
        console.log('Response Status:', response.status);
        console.log('Response Data:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log('SUCCESS: Service is listening and accepting sessions.');
            console.log('Check the main server terminal for logs: "[test_session] Mock Client Initializing..."');
        } else {
            console.log('FAILURE: Service responded but indicated an issue.');
        }
    } catch (error) {
        console.error('ERROR: Could not connect to the service.');
        console.error('Message:', error.message);
        console.log('\nMake sure the server is running on port 3001 (npm run start).');
    }
}

testSessionInit();
