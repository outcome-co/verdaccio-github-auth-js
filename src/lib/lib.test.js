const { hello } = require('./lib')

describe('my package', () => {
    test('should be true', () => {
        expect(hello()).toBeTruthy()
    })
})
