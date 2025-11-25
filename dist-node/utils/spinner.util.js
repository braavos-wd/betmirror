import ora from 'ora';
export function withSpinner(text, fn) {
    const s = ora(text).start();
    return fn()
        .then((res) => {
        s.succeed(text);
        return res;
    })
        .catch((err) => {
        s.fail(text);
        throw err;
    });
}
