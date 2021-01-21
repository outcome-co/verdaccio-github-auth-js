import Cache from './cache'

describe('Cache', () => {
    it('should cache values', () => {
        const generator = jest.fn().mockReturnValue('value')
        const cache = new Cache()

        expect(cache.get('key', generator)).toStrictEqual('value')
        expect(cache.get('key', generator)).toStrictEqual('value')
        expect(cache.get('o_key', generator)).toStrictEqual('value')
        expect(generator).toHaveBeenCalledTimes(2)
    })

    it('should cache promises', () => {
        const generator = jest.fn().mockResolvedValue('value')
        const cache = new Cache()

        const promises = [
            // eslint-disable-next-line jest/valid-expect
            expect(cache.get('key', generator)).resolves.toStrictEqual('value'),
            // eslint-disable-next-line jest/valid-expect
            expect(cache.get('key', generator)).resolves.toStrictEqual('value'),
            // eslint-disable-next-line jest/valid-expect
            expect(cache.get('o_key', generator)).resolves.toStrictEqual('value')
        ]
        expect(generator).toHaveBeenCalledTimes(2)

        return Promise.all(promises)
    })
})
