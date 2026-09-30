// 人格系统：温柔型 / 务实型 + 离线台词库
import type { PersonalityId, Species } from '../lib/tauri'

export interface PersonalityProfile {
  id: PersonalityId
  label: string
  emoji: string
  desc: string
  params: { warmth: number; practicality: number; initiative: number; talkativeness: number }
}

export const PERSONALITIES: Record<PersonalityId, PersonalityProfile> = {
  gentle: {
    id: 'gentle',
    label: '温柔型',
    emoji: '🍑',
    desc: '温和细心，关注用户，说话柔和，会主动关心你',
    params: { warmth: 0.9, practicality: 0.5, initiative: 0.7, talkativeness: 0.5 },
  },
  practical: {
    id: 'practical',
    label: '务实型',
    emoji: '📋',
    desc: '理性简洁，关注效率，偶尔提醒，不太撒娇',
    params: { warmth: 0.5, practicality: 0.95, initiative: 0.7, talkativeness: 0.3 },
  },
}

export function speciesLabel(s: Species): string {
  switch (s) {
    case 'cat':
      return '小橘猫'
    case 'bunny':
      return '小白兔'
    case 'fox':
      return '小狐狸'
  }
}

export type CannedKind =
  | 'welcome'
  | 'petted'
  | 'pettedAngry'
  | 'dragged'
  | 'sleepy'
  | 'bored'
  | 'selfTalk'
  | 'playHappy'
  | 'landOops'
  | 'summoned'
  | 'dropped'

export const CANNED: Record<PersonalityId, Record<CannedKind, string[]>> = {
  gentle: {
    welcome: ['我搬进你的桌面啦，请多关照哦～', '嗨嗨，我是{name}，以后就住在这里啦', '这里就是我的新家吗？好喜欢！'],
    petted: ['喵呜～好舒服，再摸摸嘛', '嘿嘿，被你摸到了', '你的手好暖呀', '最喜欢你啦！'],
    pettedAngry: ['呜……别戳啦，疼疼疼！', '哼！再戳我要咬你了哦！'],
    dragged: ['哇啊——飞起来啦！', '轻一点轻一点～', '放我下来嘛，我有点晕……'],
    sleepy: ['眼皮好重……我先眯一会儿哦', '呼……呼……（睡着了）'],
    bored: ['你已经坐在这里很久啦，要不要休息一下？', '我有点无聊了，陪我聊聊天嘛～', '要不要起来活动一下？我陪你去倒杯水'],
    selfTalk: ['桌面今天也很干净呀', '咦，鼠标在动耶', '呼噜呼噜……', '这里的风景真不错', '（追了追自己的尾巴）'],
    playHappy: ['好玩好玩！再来再来！', '抓到你的鼠标啦～', '陪你玩我最开心了！'],
    landOops: ['哇，差点摔到，还好我软软的', '没事没事，我很轻盈的～'],
    summoned: ['我回来啦！有没有想我呀', '召唤我有什么事嘛？'],
    dropped: ['哇啊！谢谢你接住我', '呼，安全落地～'],
  },
  practical: {
    welcome: ['已就位。需要时叫我。', '我是{name}，开始工作吧。', '桌面巡检完毕，没有异常。'],
    petted: ['……好。', '嗯，记下了。', '摸完继续干活。'],
    pettedAngry: ['频繁戳我没有意义。', '请专注，我也想专注。'],
    dragged: ['放我下来，这影响效率。', '又来这套。我记住了。'],
    sleepy: ['电量低，进入待机。', '先睡十分钟，别喊我。'],
    bored: ['这个文件你已经打开很久了，还没完成。', '先把手头的事做完，再玩。', '坐太久了，起来走两分钟。', '提醒：喝水。'],
    selfTalk: ['桌面图标有点多，该整理了。', '屏幕有点脏。', '嗯，安静就好。', '时间过得真快。'],
    playHappy: ['好吧，就一次。', '追鼠标……幼稚，但可以。'],
    landOops: ['落地稳定。', '下次注意点。'],
    summoned: ['在。说事。', '我一直在，是你没看托盘。'],
    dropped: ['落地完成。', '下次轻点放。'],
  },
}

export function pickCanned(
  personality: PersonalityId,
  kind: CannedKind,
  petName: string,
): string {
  const pool = CANNED[personality][kind] ?? CANNED.gentle.selfTalk
  const line = pool[Math.floor(Math.random() * pool.length)]
  return line.replace('{name}', petName)
}
