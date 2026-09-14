"""Champion reference data for realistic role assignments.

A Data Dragon snapshot can replace this table for real ingestion. Synthetic data uses real Riot
champion IDs and names so completion and champion grouping remain meaningful and join-compatible.
"""

from __future__ import annotations

from typing import Final, NamedTuple

from .enums import Role


class Champion(NamedTuple):
    id: int
    name: str
    name_ko: str
    #: Roles commonly played by this champion; unrealistic assignments would distort grouping.
    roles: tuple[Role, ...]


CHAMPIONS: Final[tuple[Champion, ...]] = (
    Champion(266, "Aatrox", "아트록스", (Role.TOP,)),
    Champion(103, "Ahri", "아리", (Role.MID,)),
    Champion(84, "Akali", "아칼리", (Role.MID, Role.TOP)),
    Champion(12, "Alistar", "알리스타", (Role.SUPPORT,)),
    Champion(32, "Amumu", "아무무", (Role.JUNGLE,)),
    Champion(22, "Ashe", "애쉬", (Role.BOT,)),
    Champion(432, "Bard", "바드", (Role.SUPPORT,)),
    Champion(53, "Blitzcrank", "블리츠크랭크", (Role.SUPPORT,)),
    Champion(51, "Caitlyn", "케이틀린", (Role.BOT,)),
    Champion(164, "Camille", "카밀", (Role.TOP,)),
    Champion(122, "Darius", "다리우스", (Role.TOP,)),
    Champion(131, "Diana", "다이애나", (Role.JUNGLE, Role.MID)),
    Champion(119, "Draven", "드레이븐", (Role.BOT,)),
    Champion(81, "Ezreal", "이즈리얼", (Role.BOT,)),
    Champion(114, "Fiora", "피오라", (Role.TOP,)),
    Champion(105, "Fizz", "피즈", (Role.MID,)),
    Champion(86, "Garen", "가렌", (Role.TOP,)),
    Champion(104, "Graves", "그레이브즈", (Role.JUNGLE,)),
    Champion(120, "Hecarim", "헤카림", (Role.JUNGLE,)),
    Champion(39, "Irelia", "이렐리아", (Role.TOP, Role.MID)),
    Champion(59, "JarvanIV", "자르반 4세", (Role.JUNGLE,)),
    Champion(222, "Jinx", "징크스", (Role.BOT,)),
    Champion(145, "Kaisa", "카이사", (Role.BOT,)),
    Champion(121, "Khazix", "카직스", (Role.JUNGLE,)),
    Champion(64, "LeeSin", "리 신", (Role.JUNGLE,)),
    Champion(89, "Leona", "레오나", (Role.SUPPORT,)),
    Champion(236, "Lucian", "루시안", (Role.BOT,)),
    Champion(117, "Lulu", "룰루", (Role.SUPPORT,)),
    Champion(99, "Lux", "럭스", (Role.SUPPORT, Role.MID)),
    Champion(54, "Malphite", "말파이트", (Role.TOP,)),
    Champion(11, "MasterYi", "마스터 이", (Role.JUNGLE,)),
    Champion(21, "MissFortune", "미스 포츈", (Role.BOT,)),
    Champion(25, "Morgana", "모르가나", (Role.SUPPORT,)),
    Champion(75, "Nasus", "나서스", (Role.TOP,)),
    Champion(111, "Nautilus", "노틸러스", (Role.SUPPORT,)),
    Champion(76, "Nidalee", "니달리", (Role.JUNGLE,)),
    Champion(2, "Olaf", "올라프", (Role.TOP, Role.JUNGLE)),
    Champion(61, "Orianna", "오리아나", (Role.MID,)),
    Champion(555, "Pyke", "파이크", (Role.SUPPORT,)),
    Champion(33, "Rammus", "람머스", (Role.JUNGLE,)),
    Champion(58, "Renekton", "레넥톤", (Role.TOP,)),
    Champion(107, "Rengar", "렝가", (Role.JUNGLE,)),
    Champion(92, "Riven", "리븐", (Role.TOP,)),
    Champion(360, "Samira", "사미라", (Role.BOT,)),
    Champion(113, "Sejuani", "세주아니", (Role.JUNGLE,)),
    Champion(35, "Shaco", "샤코", (Role.JUNGLE,)),
    Champion(98, "Shen", "쉔", (Role.TOP,)),
    Champion(27, "Singed", "신지드", (Role.TOP,)),
    Champion(14, "Sion", "사이온", (Role.TOP,)),
    Champion(37, "Sona", "소나", (Role.SUPPORT,)),
    Champion(16, "Soraka", "소라카", (Role.SUPPORT,)),
    Champion(134, "Syndra", "신드라", (Role.MID,)),
    Champion(91, "Talon", "탈론", (Role.MID,)),
    Champion(412, "Thresh", "쓰레쉬", (Role.SUPPORT,)),
    Champion(18, "Tristana", "트리스타나", (Role.BOT,)),
    Champion(48, "Trundle", "트런들", (Role.TOP, Role.JUNGLE)),
    Champion(23, "Tryndamere", "트린다미어", (Role.TOP,)),
    Champion(4, "TwistedFate", "트위스티드 페이트", (Role.MID,)),
    Champion(67, "Vayne", "베인", (Role.BOT,)),
    Champion(112, "Viktor", "빅토르", (Role.MID,)),
    Champion(254, "Vi", "바이", (Role.JUNGLE,)),
    Champion(8, "Vladimir", "블라디미르", (Role.MID, Role.TOP)),
    Champion(157, "Yasuo", "야스오", (Role.MID, Role.TOP)),
    Champion(777, "Yone", "요네", (Role.MID, Role.TOP)),
    Champion(238, "Zed", "제드", (Role.MID,)),
    Champion(115, "Ziggs", "직스", (Role.MID, Role.BOT)),
    Champion(26, "Zilean", "질리언", (Role.SUPPORT,)),
)

CHAMPIONS_BY_ID: Final[dict[int, Champion]] = {c.id: c for c in CHAMPIONS}

#: Candidate champions by role, used by the synthetic generator.
CHAMPIONS_BY_ROLE: Final[dict[Role, tuple[Champion, ...]]] = {
    role: tuple(c for c in CHAMPIONS if role in c.roles) for role in Role
}
