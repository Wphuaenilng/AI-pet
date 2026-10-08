// 行为规划器：行为树决定"下一个目标是什么"
import type { PetBrain } from '../../pet/PetBrain'
import { Act, BtNode, Cond, Selector, Sequence, type BtResult } from '../BehaviorTree'
import {
  ApproachAndSpeakGoal,
  ChaseGoal,
  ClimbGoal,
  DanceGoal,
  Goal,
  HappyGoal,
  IdleGoal,
  LayGoal,
  LookGoal,
  RunGoal,
  SitGoal,
  SleepGoal,
  WanderGoal,
} from './goals'

export class Planner {
  private root: BtNode

  constructor(private brain: PetBrain) {
    const b = brain
    this.root = new Selector([
      // AI 提出的高层行为意图（26.2：仅意图，由本地系统裁决）
      new Act((ctx) => ctx.takePendingIntent()),
      // 饿了讨食（附录 A.2）：凑过来要吃的，90s 冷却防刷屏
      new Sequence([
        new Cond((ctx) => ctx.emotion.v.hunger < 22 && ctx.canBeg()),
        new Act((ctx) => {
          ctx.markBeg()
          return new ApproachAndSpeakGoal(ctx as PetBrain, ctx.pickCanned('hungry'))
        }),
      ]),
      // 累了就睡
      new Sequence([
        new Cond((ctx) => ctx.emotion.v.energy < 16),
        new Act((ctx) => new SleepGoal(ctx as PetBrain, 20 + Math.random() * 18)),
      ]),
      // 用户在旁边：看 / 玩 / 撒娇
      new Sequence([
        new Cond((ctx) => ctx.settings.trackMouse && ctx.cursorNearPet() < 130 * ctx.u),
        new Selector([
          new Sequence([
            new Cond(
              (ctx) =>
                ctx.emotion.v.happiness > 55 &&
                ctx.emotion.v.boredom > 30 &&
                ctx.world.cursorMovedRecently(1200) &&
                Math.random() < 0.45,
            ),
            new Act((ctx) => new ChaseGoal(ctx as PetBrain, 3.5 + Math.random() * 3)),
          ]),
          new Sequence([
            new Cond((ctx) => ctx.cursorNearPet() < 55 * ctx.u),
            new Act((ctx) => new HappyGoal(ctx as PetBrain, 1.5)),
          ]),
          new Act((ctx) => new LookGoal(ctx as PetBrain, 2.5)),
        ]),
      ]),
      // 无聊 / 想念用户：主动凑过去说话
      new Sequence([
        new Cond(
          (ctx) =>
            ctx.settings.proactive &&
            ctx.settings.autoActivity &&
            ctx.emotion.v.boredom > 72 &&
            Math.random() < 0.5,
        ),
        new Act((ctx) => new ApproachAndSpeakGoal(ctx as PetBrain, ctx.pickCanned('bored'))),
      ]),
      // 随机行为池（"自动活动"关掉后它不再自己找事做，只回应交互）
      new Sequence([
        new Cond((ctx) => ctx.settings.autoActivity),
        new Act((ctx) => (ctx as PetBrain).pickRandomBehavior()),
      ]),
      // 兜底
      new Act(() => new IdleGoal(b, 2 + Math.random() * 3)),
    ])
  }

  pick(): Goal {
    const r: BtResult = this.root.tick(this.brain)
    // 正常情况下 Selector 会返回第一个产出的 Goal；
    // 这里只作类型兜底（防御未来节点写出不产 Goal 的分支）。
    if (typeof r === 'string' || !r) {
      return new IdleGoal(this.brain, 2 + Math.random() * 3)
    }
    return r
  }
}

export { RunGoal, SitGoal, LayGoal, LookGoal, ClimbGoal, DanceGoal, WanderGoal }
