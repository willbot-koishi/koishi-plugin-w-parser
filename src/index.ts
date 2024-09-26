import { Argv, Command, Context, Service, Session, SessionError, h, z } from 'koishi'
import { isSuccess, nil, P, Parser } from 'parsecond'

declare module 'koishi' {
    interface Context {
        parser: ParserService
    }
}

export type ExecuteEnv = {
    session: Session
}

export type EscapeResult = {
    escaped: string
    elements: string[]
}

export interface ParserState {
    terminator: Parser
}

export type ParserMiddleware<T> = (inner: StatedParser<T>) => StatedParser<T>

export type StatedParser<T> = (state: Partial<ParserState>) => Parser<T>

export type ParserLayer<T> = {
    name: string
    middleware: ParserMiddleware<T>
    precedence: number
}

export type ParserStack<T> = {
    layers: ParserLayer<T>[]
}

export interface ParserError {
}

export type Result<T, E> =
    | { val: T }
    | { err: E }

export interface ParserStacks {
    root: (env: ExecuteEnv) => Promise<h.Fragment>
    commandName: string
    command: Result<Command, {
        type: 'NotFound'
        key: string
    }>
    argv: Argv
}

export type ParserStackName = keyof ParserStacks

class ParserService extends Service {
    public stacks: {
        [K in ParserStackName]: ParserStack<ParserStacks[K]>
    } = {
        root: this.createStack(
            () => state => P.map(
                P.seq([
                    this.composeStack('command')(state),
                    this.composeStack('argv')(state)
                ]),
                ([ command, argv ]) => ({ session }) => {
                    if ('val' in command) return session.execute({
                        root: true,
                        ...argv,
                        command: command.val,
                        session
                    })

                    const { err } = command
                    if (err.type === 'NotFound') {
                        if (this.config.doReportCommandNotFound)
                            throw new SessionError('command-not-found', [ err.key ])
                    }
                }
            )
        ),
        commandName: this.createStack(
            () => () => P.join(P.some(P.satisfiy(ch => ch !== '.' && /\w/.test(ch))))
        ),
        command: this.createStack(
            () => state => P.map(
                P.sep(this.composeStack('commandName')(state), P.char('.')),
                path => {
                    const key = path.join('.')
                    const command = this.ctx.$commander.resolve(key)
                    if (! command) return { err: { type: 'NotFound', key } }
                    return { val: command }
                }
            )
        ),
        argv: this.createStack(
            () => state => P.map(
                P.alt([
                    P.right(
                        P.some(P.white),
                        P.join(P.many(P.alternative([
                            P.notEmpty(P.head(P.until(P.alt([
                                P.charIn(`'"`),
                                P.eoi,
                                state.terminator ?? P.fail(nil)
                            ])))),
                            P.join(P.seq([ P.char(`'`), P.satisfiy(ch => ch !== `'`), P.char(`'`) ])),
                            P.join(P.seq([ P.char('"'), P.satisfiy(ch => ch !== '"'), P.char('"') ])),
                        ])))
                    ),
                    P.return('')
                ]),
                Argv.parse
            )
        )
    }

    private createStack<T>(middleware: ParserMiddleware<T>): ParserStack<T> {
        return {
            layers: [ {
                precedence: 0,
                name: 'default',
                middleware
            } ]
        }
    }

    public composeStack<K extends ParserStackName>(stackName: K) {
        const stack = this.stacks[stackName]
        const sorted = [ ...stack.layers ].sort((l1, l2) => l1.precedence - l2.precedence)
        return sorted.reduce<StatedParser<ParserStacks[K]>>((ps, m) => m.middleware(ps), null)
    }

    public layer<K extends ParserStackName>(stackName: K, layer: ParserLayer<ParserStacks[K]>) {
        const stack = this.stacks[stackName]
        stack.layers.push(layer)
        return {
            dispose: () => {
                stack.layers = stack.layers.filter(({ name }) => name !== layer.name)
            }
        }
    }

    public execute(session: Session, input: string) {
        const result = this.composeStack('root')({})(input)
        if (isSuccess(result)) return result.val({ session })

        // const err = result.err as ParserError[keyof ParserError]
    }

    constructor(ctx: Context, public config: ParserService.Config) {
        super(ctx, 'parser')

        ctx.i18n.define('zh-CN', {
            'command-not-found': '未找到命令：{0}',
            'syntax-error': '语法错误：{0}'
        })

        ctx.middleware(async (session, next) => {
            const { content } = session
            const prefixes = (ctx.root.config.prefix as string[]).map(prefix => h.escape(prefix))
            const prefix = prefixes.find(prefix => content.startsWith(prefix))
            if (! prefix) return next()

            const input = content.slice(prefix.length)
            return this.execute(session, input)
        }, true)

        ctx.command('parser')

        ctx.command('parser.execute <input:text>')
            .action(({ session }, input) => {
                return this.execute(session, input)
            })
    }
}

namespace ParserService {
    export interface Config {
        doReportCommandNotFound: boolean
    }

    export const Config: z<Config> = z.object({
        doReportCommandNotFound: z.boolean().default(true).description('找不到命令时报错')
    })
}

export default ParserService