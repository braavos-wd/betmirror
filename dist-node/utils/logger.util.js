import chalk from 'chalk';
export class ConsoleLogger {
    info(msg) {
        // eslint-disable-next-line no-console
        console.log(chalk.cyan('[INFO]'), msg);
    }
    warn(msg) {
        // eslint-disable-next-line no-console
        console.warn(chalk.yellow('[WARN]'), msg);
    }
    error(msg, err) {
        // eslint-disable-next-line no-console
        console.error(chalk.red('[ERROR]'), msg, err ? `\n${err.stack ?? err.message}` : '');
    }
    debug(msg) {
        if (process.env.DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.debug(chalk.gray('[DEBUG]'), msg);
        }
    }
}
